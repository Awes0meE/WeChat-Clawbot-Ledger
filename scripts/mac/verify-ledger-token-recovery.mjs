import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { checkLedgerTokenClone } from './ledger-token-clone-check.mjs';
import { ORIGIN_IMAGE } from './managed-runtime-spec.mjs';

const docker='/Applications/Docker.app/Contents/Resources/bin/docker';
const runtimeImage='sha256:1d3fa022e1259ecee4a5bde1a5763ac5b7b32b7dc85373154b704ea0d10beebd';
const scripts=fileURLToPath(new URL('../../deploy/docker',import.meta.url));
const id=randomUUID(),prefix=`clawbot-token-recovery-${id}`,created=[];
const volumes=Object.fromEntries(['config','ledger','secrets'].map(role=>[role,`${prefix}-${role}`]));
const label=['--label',`clawbot.token-recovery=${id}`],originName=`${prefix}-source`;
const common=['--log-driver','none','--network','none','--read-only','--cap-drop','ALL',
  '--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777'];
const codeMount=['--mount',`type=bind,src=${scripts},dst=/opt/clawbot/docker,readonly`];
const sourceMounts=(rw=[])=>Object.entries(volumes).flatMap(([role,name])=>['--mount',
  `type=volume,src=${name},dst=/var/lib/clawbot-test/${role}${rw.includes(role)?'':',readonly'}`]);
function runInput(args,input,timeout=60000) {
  const r=spawnSync(docker,args,{input,encoding:'utf8',timeout,maxBuffer:2*1024*1024});
  assert.ok(!r.error&&r.status===0,'CLAWBOT_REAL_LEDGER_RECOVERY_COMMAND_FAILED');return r.stdout.trim();
}
async function run(args,timeout){return runInput(args,undefined,timeout);}
const js=code=>['--entrypoint','node',runtimeImage,'--input-type=module','-e',code];
let origin;
try {
  for(const name of Object.values(volumes)) {
    assert.equal(await run(['volume','ls','--format','{{.Name}}','--filter',`name=^${name}$`]),'');
    await run(['volume','create',...label,name]);created.push(name);
  }
  await run(['run','--rm',...label,...common,'--user','0:0','--cap-add','CHOWN',...sourceMounts(['config','ledger','secrets']),...codeMount,...js(`
    import fs from 'node:fs';import{randomBytes}from'node:crypto';
    for(const role of ['config','ledger','secrets']){const p='/var/lib/clawbot-test/'+role;if(fs.readdirSync(p).length)throw Error();fs.chmodSync(p,0o700);}
    const config=fs.readFileSync('/opt/clawbot/docker/ezbookkeeping.test.ini','utf8').replace('__GENERATE_LOCAL_TEST_SECRET__',randomBytes(32).toString('hex'));
    for(const [name,value] of [['ezbookkeeping.ini',config],['fixture-password',randomBytes(32).toString('hex')]]){
      const p='/var/lib/clawbot-test/config/'+name;fs.writeFileSync(p,value,{mode:0o600});fs.chownSync(p,1000,1000);
    }
    for(const name of ['data','log','storage']){const p='/var/lib/clawbot-test/ledger/'+name;fs.mkdirSync(p,{mode:0o700});fs.chownSync(p,1000,1000);}
    for(const role of ['config','ledger','secrets'])fs.chownSync('/var/lib/clawbot-test/'+role,1000,1000);
  `)]);
  origin=await run(['run','-d','--name',originName,...label,...common,'--user','1000:1000',...sourceMounts(['ledger']),
    '--health-cmd','wget -q -O /dev/null http://127.0.0.1:18888/healthz.json','--health-interval','1s','--health-retries','30',
    '--entrypoint','/ezbookkeeping/ezbookkeeping',ORIGIN_IMAGE,'--conf-path','/var/lib/clawbot-test/config/ezbookkeeping.ini','--no-boot-log','server','run']);
  const deadline=Date.now()+45000;let healthy=false;
  while(Date.now()<deadline){const c=JSON.parse(await run(['inspect',origin]))[0];assert.ok(c.State.Running);if(c.State.Health?.Status==='healthy'){healthy=true;break;}await delay(500);}
  assert.ok(healthy);
  // Password expansion stays inside the disposable fixture. No credential is
  // included in the host command, model output, Docker logs or repository.
  await run(['exec',origin,'/bin/sh','-c','/ezbookkeeping/ezbookkeeping --conf-path /var/lib/clawbot-test/config/ezbookkeeping.ini --no-boot-log userdata user-add --username recovery-fixture --email recovery@example.invalid --nickname fixture --default-currency SGD --password "$(cat /var/lib/clawbot-test/config/fixture-password)"']);
  const tokens={};
  async function mint(type){
    const output=await run(['run','--rm',...label,...common,'--user','1000:1000',...sourceMounts(['ledger']),
      '--entrypoint','/ezbookkeeping/ezbookkeeping',ORIGIN_IMAGE,'--conf-path','/var/lib/clawbot-test/config/ezbookkeeping.ini','--no-boot-log',
      'userdata','user-session-new','--username','recovery-fixture','--type',type,'--expiresInSeconds','3600']);
    const matches=output.match(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g);assert.equal(matches?.length,1);return matches[0];
  }
  await run(['stop','--time','10',origin]);
  tokens.http=await mint('api');tokens.mcp=await mint('mcp');
  await run(['run','--rm',...label,...common,'--user','1000:1000',...sourceMounts(['secrets']),...js(`
    import fs from 'node:fs';for(const role of ['http','mcp'])fs.writeFileSync('/var/lib/clawbot-test/secrets/'+role+'-token','stale-'+role,{mode:0o600});
  `)]);
  function rotate(action,binding=null){
    return JSON.parse(runInput(['run','--rm','-i',...label,...common,'--user','1000:1000',...codeMount,
      '--mount',`type=volume,src=${volumes.ledger},dst=/rotation/ledger,readonly`,
      '--mount',`type=volume,src=${volumes.secrets},dst=/rotation/secrets${action==='inspect'?',readonly':''}`,
      '--entrypoint','node',runtimeImage,'/opt/clawbot/docker/import-ledger-tokens.mjs'],
    JSON.stringify({action,expectedBinding:binding,expectedUsername:'recovery-fixture',...tokens})));
  }
  // The production import contract uses ezbookkeeping.db. Keep both the
  // isolated server config and the import pointed at this fixture database.
  await run(['run','--rm',...label,...common,'--user','1000:1000',...sourceMounts(['ledger']),...js(`
    import fs from 'node:fs';for(const suffix of ['','-wal','-shm']){const p='/var/lib/clawbot-test/ledger/data/ezbookkeeping-test.db'+suffix;if(fs.existsSync(p))fs.copyFileSync(p,'/var/lib/clawbot-test/ledger/data/ezbookkeeping.db'+suffix);}
  `)]);
  const first=rotate('inspect');assert.equal(rotate('apply',first.binding).status,'CLAWBOT_LEDGER_TOKENS_SAVED_MAINTENANCE_REQUIRED');
  // The copied database has the same official token records; the clone
  // checker runs the test-named one, and neither is an online source.
  async function snapshot(){
    const ids=(await run(['ps','-q'])).split('\n').filter(Boolean);
    if(ids.length){const live=JSON.parse(await run(['inspect',...ids]));assert.ok(live.every(c=>!c.Mounts.some(m=>Object.values(volumes).includes(m.Name))));}
    return await run(['run','--rm',...label,...common,'--user','1000:1000',...codeMount,
      ...Object.entries(volumes).flatMap(([role,name])=>['--mount',`type=volume,src=${name},dst=/source/${role},readonly`]),
      ...js(`import{authorizationStateAudit}from'/opt/clawbot/docker/authorization-state-audit.mjs';console.log(await authorizationStateAudit('/source'));`)]);
  }
  let baseline=await snapshot();
  async function check(){return await checkLedgerTokenClone({run,runtimeImage,sourceProfile:'isolated-test',volumes,
    rehearsalMounts:codeMount,assertSourceUnchanged:async()=>assert.equal(await snapshot(),baseline)});}
  const accepted=await check();assert.equal(accepted.serverAcceptanceVerified,true);assert.equal(accepted.productionServiceVerified,false);
  // Revoke only this disposable fixture's MCP records, then observe a real
  // server rejection rather than a synthetic HTTP error response.
  await run(['run','--rm',...label,...common,'--user','1000:1000',...sourceMounts(['ledger']),...js(`
    import{DatabaseSync}from'node:sqlite';for(const name of ['ezbookkeeping-test.db','ezbookkeeping.db']){
      const db=new DatabaseSync('/var/lib/clawbot-test/ledger/data/'+name);db.exec('DELETE FROM token_record WHERE token_type=5');db.close();}
  `)]);
  baseline=await snapshot();const revoked=await check();assert.equal(revoked.http.state,'accepted-read-only');
  assert.equal(revoked.mcp.state,'credential-rejected');assert.equal(revoked.serverAcceptanceVerified,false);
  tokens.mcp=await mint('mcp');
  await run(['run','--rm',...label,...common,'--user','1000:1000',...sourceMounts(['ledger']),...js(`
    import fs from 'node:fs';for(const suffix of ['','-wal','-shm']){const p='/var/lib/clawbot-test/ledger/data/ezbookkeeping-test.db'+suffix;const to='/var/lib/clawbot-test/ledger/data/ezbookkeeping.db'+suffix;if(fs.existsSync(p))fs.copyFileSync(p,to);else if(suffix&&fs.existsSync(to))fs.unlinkSync(to);}
  `)]);
  const renewal=rotate('inspect');assert.equal(rotate('apply',renewal.binding).status,'CLAWBOT_LEDGER_TOKENS_SAVED_MAINTENANCE_REQUIRED');
  baseline=await snapshot();assert.equal((await check()).serverAcceptanceVerified,true);assert.equal(await snapshot(),baseline);
  let checks=0,failedClone;
  await assert.rejects(checkLedgerTokenClone({runtimeImage,sourceProfile:'isolated-test',volumes,rehearsalMounts:codeMount,
    run:async(args,timeout)=>{if(args[0]==='volume'&&args[1]==='create')failedClone=args.at(-1);return await run(args,timeout);},
    assertSourceUnchanged:async()=>{assert.equal(await snapshot(),baseline);if(++checks===3)throw Error('synthetic source changed');}
  }),{message:'synthetic source changed'});
  assert.ok(failedClone);assert.equal(await run(['volume','ls','--format','{{.Name}}','--filter',`name=^${failedClone}$`]),'');
  assert.equal(await snapshot(),baseline);
  console.log('CLAWBOT_REAL_LEDGER_TOKEN_SAVE_ACCEPT_REVOKE_RENEW_AND_SOURCE_PRESERVATION_VERIFIED');
} finally {
  const ids=(await run(['ps','-a','-q','--no-trunc','--filter',`label=clawbot.token-recovery=${id}`])).split('\n').filter(Boolean);
  for(const containerId of ids){const c=JSON.parse(await run(['inspect',containerId]))[0];assert.equal(c.Config.Labels?.['clawbot.token-recovery'],id);
    if(c.State.Running)await run(['stop','--time','2',containerId]);
    if(await run(['ps','-a','-q','--filter',`id=${containerId}`]))await run(['rm',containerId]);}
  for(const name of created.reverse()){const v=JSON.parse(await run(['volume','inspect',name]))[0];assert.equal(v.Labels?.['clawbot.token-recovery'],id);
    assert.equal(await run(['ps','-a','-q','--filter',`volume=${name}`]),'');await run(['volume','rm',name]);}
}
