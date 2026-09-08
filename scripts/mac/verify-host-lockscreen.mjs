import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { operationsRoot, waitForOperationLock } from './operation-lock.mjs';
import { verifyTestHost } from './verify-test-host.mjs';
import { evaluateScreenSamples } from './screen-observation.mjs';
const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
let phase = 'setup';
function command(file, args, input) {
  const r = spawnSync(file, args, { input, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(r.status, 0, `CLAWBOT_SCREEN_CHECK_COMMAND_FAILED:${r.stderr?.match(/ERR_SQLITE_ERROR|EACCES|ENOENT/)?.[0] ?? 'command'}`); return r.stdout.trim();
}
function screenLocked() {
  const xml = command('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a']);
  const locked = command('/usr/bin/plutil', ['-extract', 'IOConsoleLocked', 'raw', '-o', '-', '-'], xml);
  assert.ok(['true', 'false'].includes(locked), 'Screen state is unknown');
  return locked === 'true';
}
const hostStatus = () => JSON.parse(readFileSync(join(operationsRoot, 'host-status.json')));
const boot = () => command('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
function hostPid(sourceCommit) {
  phase = 'host-pid';
  const job = command('/bin/launchctl', ['list', 'com.clawbot.mac-test-host']);
  const args = [...(job.match(/"ProgramArguments" = \(([\s\S]*?)\);/)?.[1] ?? '').matchAll(/"([^"\n]+)";/g)].map(m => m[1]);
  assert.deepEqual(args, [process.execPath, join(homedir(), 'Library/Application Support/Clawbot/host-releases', sourceCommit, 'scripts/mac/host-service.mjs')]);
  const pid = job.match(/"PID" = (\d+);/)?.[1]; assert.ok(pid);
  assert.equal(command('/bin/ps', ['-p', pid, '-o', 'command=']), args.join(' ')); return Number(pid);
}
const root = join(operationsRoot, 'screen-checks'); mkdirSync(root, { recursive: true, mode: 0o700 });
assert.equal(realpathSync(root), root); assert.ok(!(lstatSync(root).mode & 0o077));
const receipt = join(root, `${Date.now()}-${randomUUID()}.json`), samples = [];
let baseline;
function save(status, extra = {}) {
  writeFileSync(receipt, JSON.stringify({ version: 1, status, baseline, samples, ...extra }), { mode: 0o600 });
}
function identity(image) {
  phase = 'container-identity';
  const view = verifyTestHost({ runtimeImage: image });
  const records = JSON.parse(command(docker, ['inspect', view.origin, view.openclaw]));
  return records.map(c => ({ id: c.Id, startedAt: c.State.StartedAt, restarts: c.RestartCount }));
}
function dataCheck(image) {
  phase = 'data-check';
  // The existing baseline and config have different owners. Read/search bypass
  // permits auditing without changing their modes; all three mounts stay read-only.
  const helper = ['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH', '--security-opt', 'no-new-privileges:true',
    ...[['ledger-config', 'config'], ['ledger-data', 'ledger'], ['receipts', 'receipts']].flatMap(([role, target]) =>
      ['--mount', `type=volume,src=clawbot-test_${role},dst=/var/lib/clawbot-test/${target},readonly`]), '--entrypoint', 'node', image];
  command(docker, [...helper, '/opt/clawbot/docker/verify-state.mjs', 'check']);
  return command(docker, [...helper, '-e', 'const f=require("node:fs"),c=require("node:crypto");console.log(c.createHash("sha256").update(f.readFileSync("/var/lib/clawbot-test/receipts/p1-state-snapshot.json")).digest("hex"))']);
}
try {
  const unlock = await waitForOperationLock('screen-check-baseline');
  try {
    phase = 'screen'; assert.equal(screenLocked(), false, 'Begin this check while unlocked');
    assert.ok(!existsSync(join(operationsRoot, 'maintenance')));
    phase = 'host-status'; const status = hostStatus(); assert.equal(status.state, 'healthy'); assert.ok(Date.now() - Date.parse(status.updatedAt) < 45000);
    const release = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/Clawbot/host-releases', status.sourceCommit, 'release-runtime.json')));
    phase = 'baseline'; baseline = { at: new Date().toISOString(), boot: boot(), sourceCommit: status.sourceCommit, image: release.runtimeImage,
      pid: hostPid(status.sourceCommit), containers: identity(release.runtimeImage), snapshotSha256: dataCheck(release.runtimeImage) };
    assert.match(baseline.snapshotSha256, /^[a-f0-9]{64}$/);
  } finally { unlock(); }
  // Do not hold the operation lock while waiting for the user's screen action.
  // The existing host and its continuous observation must keep running.
  const readyUntil = Date.now() + 60000;
  while (hostStatus().state !== 'healthy' && Date.now() < readyUntil) await delay(1000);
  assert.equal(hostStatus().state, 'healthy');
  save('waiting-for-manual-lock');
  console.log(JSON.stringify({ status: 'CLAWBOT_SCREEN_PROBE_READY', receipt, minimumLockedSeconds: 60, expiresInMinutes: 30 }));
  const deadline = Date.now() + 30 * 60000;
  while (Date.now() < deadline) {
    phase = 'screen-sample'; const locked = screenLocked(), status = hostStatus();
    assert.equal(boot(), baseline.boot); assert.equal(hostPid(baseline.sourceCommit), baseline.pid);
    assert.deepEqual(identity(baseline.image), baseline.containers, 'A service restarted during the screen check');
    phase = 'health'; assert.equal(status.sourceCommit, baseline.sourceCommit); assert.equal(status.state, 'healthy');
    assert.ok(Date.now() - Date.parse(status.updatedAt) < 45000);
    const page = await fetch('http://127.0.0.1:18990/status.json', { signal: AbortSignal.timeout(5000) }); assert.equal(page.status, 200);
    const dashboard = await page.json(); assert.ok(dashboard.boundaryHealthy && dashboard.acPower && Date.now() - Date.parse(dashboard.updatedAt) < 45000);
    // No credentials are used: this tests only Docker namespace HTTPS egress,
    // not model authentication, actual WeChat polling or a public Tunnel.
    phase = 'https-egress'; command(docker, ['exec', baseline.containers[1].id, 'node', '-e', 'fetch("https://chatgpt.com/",{method:"HEAD",redirect:"manual",signal:AbortSignal.timeout(5000)}).then(()=>process.stdout.write("reachable")).catch(()=>process.exit(1))']);
    samples.push({ at: new Date().toISOString(), locked, healthy: true, egress: true });
    const result = evaluateScreenSamples(samples);
    save(result.complete ? 'verifying-data-after-unlock' : locked ? 'locked-observation' : 'waiting-for-manual-lock', result);
    if (result.complete) {
      assert.equal(dataCheck(baseline.image), baseline.snapshotSha256, 'Saved database baseline was changed');
      save('CLAWBOT_SCREEN_LOCK_CONTINUITY_VERIFIED', { ...result, databasesUnchanged: true, userUnlocked: true });
      console.log(JSON.stringify({ status: 'CLAWBOT_SCREEN_LOCK_CONTINUITY_VERIFIED', receipt, lockedSeconds: result.lockedMs / 1000, databasesUnchanged: true }));
      process.exit(0);
    }
    await delay(5000);
  }
  save('expired-without-complete-lock-unlock'); console.log('CLAWBOT_SCREEN_PROBE_EXPIRED_NO_ACCEPTANCE'); process.exitCode = 1;
} catch (error) { save('failed-no-acceptance', { phase }); console.error(`CLAWBOT_SCREEN_CHECK_FAILED_NO_ACCEPTANCE:${phase}:${error.code ?? 'check'}`); process.exitCode = 1; }
