import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, existsSync, rmdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { operationsRoot } from './operation-lock.mjs';
import { verifyTestHost } from './verify-test-host.mjs';
import { readManagedHostRelease } from './managed-host-release.mjs';
import { authorizationStageConfig, authorizationStageArgs, validateAuthorizationStage, AUTH_STAGE_ROOT } from './authorization-stage.mjs';
import { summarizeModelAuthorization } from './model-authorization.mjs';
const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const root = join(operationsRoot, 'authorization-stages');
function run(args, input, timeout = 90000) {
  const r = spawnSync(docker, args, { input, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('CLAWBOT_AUTH_STAGE_OPERATION_FAILED');
  return r.stdout.trim();
}
function checkImage(stage) {
  const image = JSON.parse(run(['image', 'inspect', stage.runtimeImage]))[0];
  assert.ok(image.Id === stage.runtimeImage && image.Architecture === 'arm64');
  if (stage.targetProfile === 'production') assert.equal(image.Config.Labels?.['org.opencontainers.image.revision'], stage.hostSourceCommit);
}
function checkVolume(stage) {
  const v = JSON.parse(run(['volume', 'inspect', stage.volume]))[0];
  assert.ok(v.Name === stage.volume && v.Driver === 'local' && !Object.keys(v.Options ?? {}).length
    && v.Labels?.['clawbot.purpose'] === 'authorization-stage' && v.Labels['clawbot.stage'] === stage.id);
  assert.ok(!v.Labels?.['clawbot.project'] && !v.Labels?.['clawbot.cutover']);
  assert.equal(run(['ps', '-q', '--filter', `volume=${stage.volume}`]), '');
  checkImage(stage);
}
let stageLock;
try {
  const [action, input] = process.argv.slice(2);
  assert.ok(['prepare', 'inspect', 'login', 'verify-model'].includes(action) && input && process.argv.length === 4);
  // Authorization links/codes belong only in the user's visible local terminal.
  // Refuse a captured command before creating any resources or starting OAuth.
  if (action === 'login') assert.ok(process.stdin.isTTY && process.stdout.isTTY, 'Visible interactive terminal required');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assert.ok(realpathSync(root) === root && lstatSync(root).uid === process.getuid() && !(lstatSync(root).mode & 0o077));
  let stage, file;
  if (action === 'prepare') {
    let runtimeImage, hostSourceCommit, targetProfile;
    if (input === '--test') {
      const base = join(homedir(), 'Library/Application Support/Clawbot');
      hostSourceCommit = JSON.parse(readFileSync(join(base, 'operations/host-status.json'))).sourceCommit;
      assert.match(hostSourceCommit, /^[a-f0-9]{40}$/);
      runtimeImage = JSON.parse(readFileSync(join(base, 'host-releases', hostSourceCommit, 'release-runtime.json'))).runtimeImage;
      verifyTestHost({ runtimeImage }); targetProfile = 'isolated-test';
    } else {
      const { spec } = readManagedHostRelease(resolve(input));
      runtimeImage = spec.services.openclaw.image; hostSourceCommit = spec.sourceCommit; targetProfile = 'production';
    }
    const id = randomUUID();
    stage = validateAuthorizationStage({ version: 1, id, volume: `clawbot-auth-stage-${id}`, runtimeImage,
      hostSourceCommit, targetProfile, createdAt: new Date().toISOString() });
    checkImage(stage);
    file = join(root, `${id}.json`); assert.ok(!existsSync(file));
    // Random new volume only. It carries no production labels or source state.
    assert.equal(run(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${stage.volume}$`]), '');
    run(['volume', 'create', '--label', 'clawbot.purpose=authorization-stage', '--label', `clawbot.stage=${id}`, stage.volume]);
    // Record the owned resource before initialization so a failed prepare stays
    // inspectable. A missing completion marker prevents subsequent use.
    writeFileSync(file, JSON.stringify(stage), { flag: 'wx', mode: 0o600 });
    const script = `const fs=require('node:fs');const root=process.argv[1],config=JSON.parse(process.argv[2]);
      if(fs.readdirSync(root).length)throw Error('NONEMPTY_AUTH_STAGE');
      for(const name of ['openclaw','codex','workspace'])fs.mkdirSync(root+'/'+name,{mode:0o700});
      fs.writeFileSync(root+'/openclaw/openclaw.json',JSON.stringify(config),{mode:0o600});fs.chownSync(root+'/openclaw/openclaw.json',1000,1000);
      fs.writeFileSync(root+'/initialized.json',JSON.stringify({version:1,id:process.argv[3]}),{mode:0o444});
      for(const name of ['openclaw','codex','workspace'])fs.chownSync(root+'/'+name,1000,1000);
      fs.chmodSync(root,0o700);fs.chownSync(root,1000,1000);`;
    run(['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
      '--security-opt', 'no-new-privileges:true', '--mount', `type=volume,src=${stage.volume},dst=${AUTH_STAGE_ROOT}`,
      '--entrypoint', 'node', runtimeImage, '-e', script, AUTH_STAGE_ROOT, JSON.stringify(authorizationStageConfig()), id]);
    console.log(JSON.stringify({ status: 'CLAWBOT_AUTH_STAGE_PREPARED', receipt: file, targetProfile, productionChanged: false }));
  } else {
    file = resolve(input); assert.equal(join(root, file.split('/').at(-1)), file);
    const stat = lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077) && stat.size < 4096);
    stage = validateAuthorizationStage(JSON.parse(readFileSync(file)));
    assert.equal(file, join(root, `${stage.id}.json`));
    const lock = file + '.lock'; mkdirSync(lock, { mode: 0o700 }); stageLock = lock;
    checkVolume(stage);
    const marker = run(['run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--mount', `type=volume,src=${stage.volume},dst=${AUTH_STAGE_ROOT},readonly`,
      '--entrypoint', 'node', stage.runtimeImage, '-e', `process.stdout.write(require('node:fs').readFileSync('${AUTH_STAGE_ROOT}/initialized.json','utf8'))`]);
    assert.deepEqual(JSON.parse(marker), { version: 1, id: stage.id });
    if (action === 'inspect') {
      const raw = JSON.parse(run([...authorizationStageArgs(stage), 'models', 'status', '--agent', 'bookkeeper', '--json']));
      console.log(JSON.stringify({ ...summarizeModelAuthorization(raw), scope: 'authorization-stage', productionChanged: false }));
    } else if (action === 'verify-model') {
      const script = readFileSync(new URL('../../deploy/docker/verify-staged-model.mjs', import.meta.url), 'utf8');
      const raw = run([...authorizationStageArgs(stage).slice(0, -1), '--input-type=module', '-e', script], undefined, 150000);
      // Runtime logging may precede the final JSON. Only publish its exact fixed
      // success marker and fields; never forward arbitrary diagnostic output.
      const result = raw.split('\n').filter(line => line.startsWith('{')).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).find(value => value?.status === 'CLAWBOT_STAGED_MODEL_AUTH_VERIFIED');
      assert.ok(result?.remoteVerified === true && result.model === 'gpt-5.6-sol' && result.harness === 'codex'
        && result.tools === 0 && result.exactSyntheticReply === true && result.productionChanged === false);
      const report = { version: 1, status: result.status, stageId: stage.id, runtimeImage: stage.runtimeImage,
        hostSourceCommit: stage.hostSourceCommit, model: 'gpt-5.6-sol', harness: 'codex',
        remoteVerified: true, exactSyntheticReply: true, tools: 0,
        productionChanged: false, observedAt: new Date().toISOString() };
      const receipt = join(root, `${stage.id}.model-check-${Date.now()}.json`);
      writeFileSync(receipt, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ ...report, receipt }));
    } else {
      const result = spawnSync(docker, [...authorizationStageArgs(stage, { interactive: true }),
        'models', 'auth', 'login', '--provider', 'openai', '--agent', 'bookkeeper', '--device-code'], { stdio: 'inherit' });
      // Even a successful login is only staged; nothing imports or resumes.
      console.log(result.status === 0 ? 'CLAWBOT_LOGIN_STAGED_NOT_IMPORTED' : 'CLAWBOT_LOGIN_INCOMPLETE_NOT_IMPORTED');
      process.exitCode = result.status === 0 ? 0 : 1;
    }
  }
} catch {
  console.error('CLAWBOT_AUTH_STAGE_REFUSED_NO_IMPORT'); process.exitCode = 1;
} finally { if (stageLock) rmdirSync(stageLock); }
