import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { validateOriginConfig } from '../../deploy/guard/origin-identity.mjs';
import { acquireOperationLock } from './operation-lock.mjs';
acquireOperationLock('guard-verification');

const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const env = { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}` };
const compose = ['compose', '-f', 'deploy/docker/compose.test.yml'];
const marker = randomBytes(6).toString('hex'), containers = [], volumes = [];
let origin, image, paused = false, stopped = false, stage = 'preflight';
function run(args, input, timeout = 30_000) {
  const result = spawnSync(docker, args, { cwd: root, env, input, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Guard test command failed: ${args[0]}`);
  return result.stdout;
}
function checkHost() {
  const result = spawnSync(process.execPath, ['scripts/mac/verify-test-host.mjs'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, 'Host isolation check failed');
}
function policyVolume(policy, suffix) {
  const name = `clawbot-guard-check-${marker}-${suffix}`;
  assert.equal(run(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${name}$`]).trim(), '');
  run(['volume', 'create', '--label', `clawbot.guard-check=${marker}`, name]); volumes.push(name);
  run(['run', '--rm', '-i', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL',
    '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges:true', '--mount', `type=volume,src=${name},dst=/run/clawbot-guard`,
    '--entrypoint', 'node', image, '--input-type=module', '-e',
    'import{writeFileSync,chownSync}from"node:fs";let s="";for await(const c of process.stdin)s+=c;writeFileSync("/run/clawbot-guard/policy.json",s,{mode:0o400,flag:"wx"});chownSync("/run/clawbot-guard/policy.json",1000,1000);'], JSON.stringify(policy));
  return name;
}
function launchGuard(volume, owner = origin) {
  const name = `clawbot-guard-check-${marker}-${containers.length}`;
  const id = run(['run', '-d', '--name', name, '--label', `clawbot.guard-check=${marker}`,
    '--network', `container:${owner}`, '--pid', `container:${owner}`, '--read-only', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m',
    '--mount', `type=volume,src=${volume},dst=/run/clawbot-guard,readonly`, image]).trim();
  containers.push(id); return id;
}
function published(owner = origin) {
  const value = run(['run', '--rm', '--network', `container:${owner}`, '--read-only', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--entrypoint', 'node', image, '--input-type=module', '-e',
    'try{const r=await fetch("http://127.0.0.1:18991",{signal:AbortSignal.timeout(800)});console.log(r.ok&&await r.text()==="CLAWBOT_GUARDED_TEST_PUBLISHER"?"yes":"no")}catch{console.log("no")}']);
  return value.trim() === 'yes';
}
async function waitForPublisher(expected, owner = origin) {
  const until = Date.now() + 15000;
  do { if (published(owner) === expected) return; await delay(250); } while (Date.now() < until);
  throw new Error('Publisher state did not converge');
}
async function assertBlocked(id, owner = origin) {
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    assert.equal(published(owner), false);
    await delay(250);
  }
  assert.ok(run(['logs', id]).includes('"state":"blocked"'));
}
try {
  checkHost();
  origin = run([...compose, 'ps', '-q', 'origin']).trim(); assert.match(origin, /^[a-f0-9]{64}$/);
  image = JSON.parse(run(['image', 'inspect', 'clawbot-guard-test:p2']))[0].Id;
  const ini = run(['exec', origin, 'cat', '/var/lib/clawbot-test/config/ezbookkeeping.ini']);
  const policy = { version: 1, profile: 'isolated-test', port: 18888, root: '/var/lib/clawbot-test',
    configPath: '/var/lib/clawbot-test/config/ezbookkeeping.ini', dbPath: '/var/lib/clawbot-test/ledger/data/ezbookkeeping-test.db',
    configSha256: createHash('sha256').update(ini).digest('hex') };
  validateOriginConfig(ini, policy);
  const good = policyVolume(policy, 'good');
  stage = 'healthy'; const first = launchGuard(good); await waitForPublisher(true);
  console.log('CLAWBOT_GUARD_OK:verified-origin-publishes');
  stage = 'health-loss'; run(['pause', origin]); paused = true;
  await waitForPublisher(false); console.log('CLAWBOT_GUARD_OK:health-loss-closes-publisher');
  run(['unpause', origin]); paused = false; await waitForPublisher(true);
  console.log('CLAWBOT_GUARD_OK:health-recovery-rechecks-origin');
  stage = 'guardian-death'; run(['kill', '--signal', 'KILL', first]); await waitForPublisher(false);
  assert.equal(JSON.parse(run(['inspect', origin]))[0].State.Running, true);
  console.log('CLAWBOT_GUARD_OK:guardian-death-leaves-no-publisher');
  stage = 'wrong-config'; const bad = policyVolume({ ...policy, configSha256: '0'.repeat(64) }, 'bad');
  const wrong = launchGuard(bad); await assertBlocked(wrong); run(['stop', wrong]);
  console.log('CLAWBOT_GUARD_OK:wrong-config-never-publishes');
  stage = 'wrong-origin';
  const fake = run(['run', '-d', '--label', `clawbot.guard-check=${marker}`, '--read-only', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--entrypoint', 'node', image, '--input-type=module', '-e',
    'import http from"node:http";http.createServer((q,r)=>{r.end(q.url==="/healthz.json"?JSON.stringify({success:true}):"ezBookkeeping")}).listen(18888,"127.0.0.1");']).trim();
  containers.push(fake);
  const fakeGuard = launchGuard(good, fake); await assertBlocked(fakeGuard, fake);
  console.log('CLAWBOT_GUARD_OK:healthy-impostor-never-publishes');
  stage = 'origin-stop'; const last = launchGuard(good); await waitForPublisher(true);
  stopped = true; run([...compose, 'stop', 'openclaw', 'origin']);
  for (let attempt = 0; attempt < 20 && JSON.parse(run(['inspect', last]))[0].State.Running; attempt++) await delay(250);
  assert.equal(JSON.parse(run(['inspect', last]))[0].State.Running, false);
  console.log('CLAWBOT_GUARD_OK:origin-namespace-death-stops-guardian');
  console.log('CLAWBOT_GUARD_ISOLATED_FAULT_MATRIX_OK');
} catch { console.error(`CLAWBOT_GUARD_FAILED:${stage}`); process.exitCode = 1; }
finally {
  if (paused) { try { run(['unpause', origin]); } catch { process.exitCode = 1; } }
  for (const id of containers.reverse()) {
    try {
      const c = JSON.parse(run(['inspect', id]))[0];
      if (c.Config.Labels?.['clawbot.guard-check'] === marker) run(['rm', '-f', id]);
    } catch { console.error('CLAWBOT_GUARD_CHECK_CONTAINER_RETAINED'); process.exitCode = 1; }
  }
  for (const name of volumes) {
    try {
      const v = JSON.parse(run(['volume', 'inspect', name]))[0];
      if (v.Labels?.['clawbot.guard-check'] === marker) run(['volume', 'rm', name]);
    } catch { console.error('CLAWBOT_GUARD_CHECK_VOLUME_RETAINED'); process.exitCode = 1; }
  }
  if (stopped) {
    try { run([...compose, 'up', '-d', '--wait', '--wait-timeout', '120', 'origin', 'openclaw'], undefined, 150000); checkHost(); }
    catch { console.error('CLAWBOT_GUARD_TEST_SERVICE_RECOVERY_FAILED'); process.exitCode = 1; }
  }
}
