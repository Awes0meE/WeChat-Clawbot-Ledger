import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOST_FILES } from './managed-host-release.mjs';
import { managedRuntimeSpec, managedCompose } from './managed-runtime-spec.mjs';
import { writeProductionDashboardRelease, readProductionDashboardRelease } from './production-dashboard-release.mjs';
import { operationsRoot } from './operation-lock.mjs';
assert.ok(!existsSync(join(operationsRoot, 'production-enabled.json')));
const label = 'com.clawbot.mac-production-dashboard';
assert.notEqual(spawnSync('/bin/launchctl', ['list', label], { encoding: 'utf8' }).status, 0);
const root = join(homedir(), 'Library/Application Support/Clawbot/production-host-releases');
mkdirSync(root, { recursive: true, mode: 0o700 }); assert.equal(realpathSync(root), root);
const fixture = realpathSync(mkdtempSync(join(root, 'dashboard-http-fixture-')));
const packages = join(homedir(), 'Library/Application Support/Clawbot/production-dashboard-releases');
mkdirSync(packages, { recursive: true, mode: 0o700 }); assert.equal(realpathSync(packages), packages);
const packageFixture = realpathSync(mkdtempSync(join(packages, 'dashboard-http-fixture-')));
let switchFixture;
try {
  const host = join(fixture, 'host'); mkdirSync(host, { mode: 0o700 });
  const target = { profile: 'production', project: 'clawbot-production', runtimeImage: `sha256:${'a'.repeat(64)}`,
    guardImage: `sha256:${'b'.repeat(64)}`, sourceCommit: 'c'.repeat(40), cutoverId: randomUUID(),
    sourceSnapshotSha256: 'd'.repeat(64), importManifestSha256: 'e'.repeat(64) }, files = {};
  for (const name of [...HOST_FILES, 'compose.json']) {
    const data = name === 'compose.json' ? Buffer.from(JSON.stringify(managedCompose(managedRuntimeSpec(target)))) : readFileSync(new URL(name, import.meta.url));
    writeFileSync(join(host, name), data, { flag: 'wx', mode: 0o400 }); files[name] = createHash('sha256').update(data).digest('hex');
  }
  writeFileSync(join(host, 'host-release.json'), JSON.stringify({ version: 1, target, files }), { flag: 'wx', mode: 0o400 });
  const directory = join(packageFixture, 'dashboard');
  writeProductionDashboardRelease(directory, host, 'f'.repeat(40));
  const oldTask = join(homedir(), 'Library/LaunchAgents/com.clawbot.mac-test-host.plist');
  const oldBytes = existsSync(oldTask) ? readFileSync(oldTask) : null;
  const refused = spawnSync(process.execPath, [fileURLToPath(new URL('./switch-production-dashboard.mjs', import.meta.url)), directory],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  assert.equal(refused.status, 1); assert.equal(refused.stderr.trim(), 'CLAWBOT_PRODUCTION_DASHBOARD_SWITCH_REFUSED:preflight');
  assert.deepEqual(existsSync(oldTask) ? readFileSync(oldTask) : null, oldBytes);
  if (oldBytes) {
    const parsed = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: oldBytes, encoding: 'utf8' });
    assert.equal(parsed.status, 0);
    const switches = join(operationsRoot, 'dashboard-switches');
    mkdirSync(switches, { recursive: true, mode: 0o700 }); assert.equal(realpathSync(switches), switches);
    switchFixture = join(switches, randomUUID()); mkdirSync(switchFixture, { mode: 0o700 });
    const { release } = readProductionDashboardRelease(directory);
    const record = { version: 2, purpose: 'dashboard-switch', operationPid: process.pid, directory,
      oldCommit: JSON.parse(parsed.stdout).WorkingDirectory.split('/').at(-1), sourceCommit: release.sourceCommit, taskSha256: release.taskSha256 };
    writeFileSync(join(switchFixture, 'switch.json'), JSON.stringify(record), { flag: 'wx', mode: 0o400 });
    writeFileSync(join(switchFixture, 'previous.plist'), oldBytes, { flag: 'wx', mode: 0o400 });
    writeFileSync(join(switchFixture, 'started.json'), JSON.stringify({ version: 1, state: 'started', updatedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o400 });
    const recovery = spawnSync(process.execPath, [fileURLToPath(new URL('./restore-dashboard-switch.mjs', import.meta.url)), switchFixture],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    assert.equal(recovery.status, 1); assert.equal(recovery.stderr.trim(), 'CLAWBOT_DASHBOARD_SWITCH_RESTORE_REFUSED:preflight');
    assert.deepEqual(readFileSync(oldTask), oldBytes); assert.equal(existsSync(join(switchFixture, 'restores')), false);
    console.log('CLAWBOT_RUNNING_DASHBOARD_SWITCH_OWNER_RECOVERY_REFUSED');
  }
  const r = spawnSync(process.execPath, [join(directory, 'scripts/mac/production-status-server.mjs'), '--verify-inactive'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  if (r.status !== 0) {
    const stage = r.stderr.match(/CLAWBOT_PRODUCTION_DASHBOARD_HTTP_CHECK_FAILED:[a-z]+/)?.[0];
    if (stage) console.error(stage);
  }
  assert.equal(r.status, 0, 'CLAWBOT_PRODUCTION_DASHBOARD_FIXTURE_FAILED');
  assert.equal(r.stdout.trim(), 'CLAWBOT_PRODUCTION_DASHBOARD_HTTP_DISABLED_BOUNDARIES_VERIFIED');
  const script = join(directory, 'deploy/dashboard/production.js');
  chmodSync(script, 0o600); assert.throws(() => readProductionDashboardRelease(directory));
  chmodSync(script, 0o400); readProductionDashboardRelease(directory);
  chmodSync(script, 0o600); writeFileSync(script, '// synthetic changed content'); chmodSync(script, 0o400);
  assert.throws(() => readProductionDashboardRelease(directory));
  assert.ok(!existsSync(join(operationsRoot, 'production-enabled.json')));
  assert.notEqual(spawnSync('/bin/launchctl', ['list', label], { encoding: 'utf8' }).status, 0);
  console.log(r.stdout.trim());
  console.log('CLAWBOT_PRODUCTION_DASHBOARD_WRITABLE_AND_TAMPERED_ASSETS_REFUSED');
  console.log('CLAWBOT_DISABLED_PRODUCTION_DASHBOARD_SWITCH_REFUSED_WITHOUT_TASK_CHANGES');
} finally {
  if (switchFixture) rmSync(switchFixture, { recursive: true, force: true });
  rmSync(packageFixture, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true });
}
