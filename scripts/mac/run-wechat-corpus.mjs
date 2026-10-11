import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { waitForOperationLock } from './operation-lock.mjs';

const unlock = await waitForOperationLock('wechat-corpus');
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(homedir(), 'Library/Application Support/Clawbot/acceptance/wechat-corpus-2026-09-13');
mkdirSync(directory, {recursive:true, mode:0o700});
const image = process.env.CLAWBOT_CORPUS_IMAGE;
const imageCasesDirectory = process.env.CLAWBOT_IMAGE_CASES_DIR;
// A targeted regression needs enough credential lifetime for its own cases,
// not the four-hour reserve used by the full corpus.
const selectedCaseCount = process.argv[2] === 'run' ? process.argv.slice(3).length : 0;
const requiredAuthMs = selectedCaseCount
  ? Math.max(30 * 60_000, selectedCaseCount * 120_000 + 10 * 60_000) : 4 * 3600_000;
assert.ok(image, 'Set CLAWBOT_CORPUS_IMAGE to the exact isolated image being verified');
assert.match(image, /^clawbot-message-acceptance:[a-z0-9.-]+$/u);
const override = join(directory, 'compose.override.json');
writeFileSync(override, JSON.stringify({ services: Object.fromEntries(['init','openclaw','cli'].map((name) => [name, { image,
  ...(name === 'cli' ? { ...(imageCasesDirectory ? { environment: { CLAWBOT_IMAGE_CASES: '/image-cases/cases.json' } } : {}), volumes: [
    `${join(root,'test-cases')}:/test-cases:ro`,
    `${join(root,'deploy/docker/verify-wechat-corpus.mjs')}:/opt/clawbot/docker/verify-wechat-corpus.mjs:ro`,
    ...(imageCasesDirectory ? [`${imageCasesDirectory}:/image-cases:ro`] : []),
  ] } : {}) }])) }), {mode:0o600});
const compose = ['compose','-f',join(root,'deploy/docker/compose.test.yml'),'-f',override];
function run(args, input, timeout=120000) {
  const r=spawnSync('docker',args,{encoding:'utf8',input,timeout,maxBuffer:8*1024*1024});
  if(r.status!==0) throw new Error(`Corpus Docker operation failed: ${args.slice(0,2).join(' ')} (${r.status})`);
  return r.stdout.trim();
}
try {
  // Never run two model runtimes over the same isolated state.
  assert.equal(run([...compose,'ps','-q','openclaw']), '');
  assert.equal(run(['ps','-q','--filter','label=com.docker.compose.project=clawbot-test','--filter','label=com.docker.compose.service=cli']), '', 'An isolated model CLI is already running');
  run([...compose,'--profile','setup','run','--rm','-T','init']);
  run([...compose,'--profile','setup','run','--rm','-T','init','refresh-agent-limits']);
  run([...compose,'--profile','setup','run','--rm','-T','init','refresh-image-understanding']);
  run([...compose,'up','-d','--wait','origin']);
  const id=run([...compose,'ps','-q','origin']);
  const origin=JSON.parse(run(['inspect',id]))[0];
  assert.equal(origin.Config.Labels['com.docker.compose.project'],'clawbot-test');
  assert.equal(origin.Config.Labels['com.docker.compose.service'],'origin');
  assert.equal(Object.keys(origin.HostConfig.PortBindings??{}).length,0);
  const status=run([...compose,'--profile','setup','run','--rm','-T','init','token-status']);
  if(status==='EMPTY') {
    const create='if [ ! -f /var/lib/clawbot-test/ledger/.test-user-created ]; then /ezbookkeeping/ezbookkeeping --conf-path /var/lib/clawbot-test/config/ezbookkeeping.ini --no-boot-log userdata user-add --username clawbot-test --email clawbot-test@example.invalid --nickname clawbot-test --default-currency SGD --password "$(cat /var/lib/clawbot-test/bootstrap/password)" && touch /var/lib/clawbot-test/ledger/.test-user-created; fi';
    run(['exec',id,'/bin/sh','-c',create]);
    const tokens={};
    for(const kind of ['api','mcp']) {
      const output=run(['exec',id,'/ezbookkeeping/ezbookkeeping','--conf-path','/var/lib/clawbot-test/config/ezbookkeeping.ini','--no-boot-log','userdata','user-session-new','--username','clawbot-test','--type',kind,'--expiresInSeconds','604800']);
      const matches=output.match(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g);
      assert.equal(matches?.length,1);tokens[kind]=matches[0];
    }
    run([...compose,'--profile','setup','run','--rm','-T','init','tokens'],JSON.stringify(tokens));
  } else assert.equal(status,'READY');
  const source=JSON.parse(run(['inspect','clawbot-production-openclaw-1']))[0];
  assert.equal(source.Config.Labels['com.docker.compose.project'],'clawbot-production');
  const authVolume=source.Mounts.find((m)=>m.Destination==='/var/lib/clawbot/codex');
  assert.equal(authVolume?.Type,'volume');
  // Copy only an unexpired Codex credential into empty isolated state; source
  // is mounted read-only, transcripts and production ledger are never copied.
  const copy=`const fs=require('node:fs');const p='/target/auth.json';const valid=(b)=>{try{const a=JSON.parse(b);if(a.auth_mode!=='chatgpt'||!a.tokens?.access_token)return false;const exp=JSON.parse(Buffer.from(a.tokens.access_token.split('.')[1],'base64url')).exp;return exp*1000-Date.now()>=${requiredAuthMs};}catch{return false;}};if(!fs.existsSync(p)||!valid(fs.readFileSync(p))){const b=fs.readFileSync('/source/auth.json');if(!valid(b))throw Error('AUTH_TOO_SHORT_FOR_SUITE');fs.writeFileSync(p,b,{mode:0o600});fs.chmodSync(p,0o600);}console.log('ISOLATED_AUTH_PRESENT');`;
  run(['run','--rm','--network','none','--read-only','--user','1000:1000','--entrypoint','node',
    '--mount',`type=volume,src=${authVolume.Name},dst=/source,readonly`,
    '--mount','type=volume,src=clawbot-test_codex-state,dst=/target',image,'-e',copy]);
  const phase=process.argv[2]??'run';
  if(phase==='prepare') { console.log(JSON.stringify({status:'ISOLATED_CORPUS_READY',productionChanged:false})); }
  else {
    assert.equal(phase,'run');
    const log=createWriteStream(join(directory,`raw-${Date.now()}.log`),{mode:0o600});
    const args=process.argv.slice(3);
    const child=spawn('docker',[...compose,'run','--rm','--no-deps','-T','cli','/opt/clawbot/docker/verify-wechat-corpus.mjs',...args],{cwd:root,stdio:['ignore','pipe','pipe']});
    const stdoutDecoder=new StringDecoder('utf8');
    let pending='';
    child.stdout.on('data',(b)=>{log.write(b);pending+=stdoutDecoder.write(b);const lines=pending.split('\n');pending=lines.pop();for(const line of lines)if(line.startsWith('{"corpus'))console.log(line);});
    child.stderr.on('data',(b)=>log.write(b));
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    log.end();
    if(code!==0){console.error(JSON.stringify({status:'CORPUS_RUN_NEEDS_REVIEW',exitCode:code,privateLogDirectory:directory}));process.exitCode=1;}
  }
} finally { unlock(); }
