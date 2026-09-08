import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { waitForOperationLock, operationsRoot } from './operation-lock.mjs';
import { verifyTestHost } from './verify-test-host.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const env = { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}` };
const mode = process.argv[2];
assert.ok(['prepare', 'check'].includes(mode), 'Expected prepare or check');
function run(command, args, timeout = 45000) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, 'CLAWBOT_REBOOT_COMMAND_FAILED');
  return result.stdout.trim();
}
const boot = run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
assert.match(boot, /^[A-Fa-f0-9-]{36}$/);
const file = mode === 'prepare' ? join(operationsRoot, `reboot-${boot}.json`) : resolve(process.argv[3] ?? '');
assert.equal(join(operationsRoot, file.split('/').at(-1)), file, 'Reboot receipt must be in private operations directory');
let before;
if (mode === 'check') {
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077));
  before = JSON.parse(readFileSync(file));
  assert.equal(before.version, 1);
  assert.notEqual(before.boot, boot, 'Mac has not rebooted since the saved baseline');
} else {
  assert.ok(!existsSync(file), 'A baseline for this boot already exists');
}
const unlock = await waitForOperationLock(`reboot-${mode}`);
try {
  assert.ok(!existsSync(join(operationsRoot, 'maintenance')), 'Maintenance is active');
  const status = JSON.parse(readFileSync(join(operationsRoot, 'host-status.json')));
  assert.ok(status.state === 'healthy' && Date.now() - Date.parse(status.updatedAt) < 45000);
  assert.match(status.sourceCommit, /^[a-f0-9]{40}$/);
  const release = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/Clawbot/host-releases', status.sourceCommit, 'release-runtime.json')));
  if (before) {
    assert.equal(status.sourceCommit, before.sourceCommit);
    assert.equal(release.runtimeImage, before.runtimeImage);
    assert.ok(Date.parse(status.updatedAt) > Date.parse(before.preparedAt));
  }
  const identity = verifyTestHost({ runtimeImage: release.runtimeImage });
  // The isolated receiver has no live channel. Capture only hashes from the
  // healthy pair; the actual reboot, rather than an extra stop, is the fault.
  if (mode === 'prepare') run(docker, ['compose', '-f', 'deploy/docker/compose.test.yml', 'run', '--rm', '-T', '--no-deps', '--entrypoint', 'node', 'init', '/opt/clawbot/docker/verify-state.mjs', 'save']);
  const snapshotSHA256 = run(docker, ['compose', '-f', 'deploy/docker/compose.test.yml', 'run', '--rm', '-T', '--no-deps', '--entrypoint', 'node', 'init', '-e',
    "const fs=require('node:fs'),c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync('/var/lib/clawbot-test/receipts/p1-state-snapshot.json')).digest('hex'))"]);
  assert.match(snapshotSHA256, /^[a-f0-9]{64}$/);
  if (before) assert.equal(snapshotSHA256, before.snapshotSHA256, 'Saved database baseline was replaced');
  run(docker, ['compose', '-f', 'deploy/docker/compose.test.yml', 'run', '--rm', '-T', '--no-deps', '--entrypoint', 'node', 'init', '/opt/clawbot/docker/verify-state.mjs', 'check']);
  const response = await fetch('http://127.0.0.1:18990/', { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  if (mode === 'prepare') {
    writeFileSync(file, JSON.stringify({ version: 1, boot, preparedAt: new Date().toISOString(), sourceCommit: status.sourceCommit,
      runtimeImage: release.runtimeImage, snapshotSHA256, identity }, null, 2), { flag: 'wx', mode: 0o600 });
  } else {
    writeFileSync(`${file}.verified.json`, JSON.stringify({ version: 1, status: 'CLAWBOT_MAC_REBOOT_RECOVERY_OK', boot,
      verifiedAt: new Date().toISOString(), baseline: file, sourceCommit: status.sourceCommit,
      runtimeImage: release.runtimeImage, databasesUnchanged: true, automaticRecovery: true, dashboardHTTP: 200 }, null, 2), { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ status: mode === 'prepare' ? 'CLAWBOT_REBOOT_BASELINE_READY' : 'CLAWBOT_MAC_REBOOT_RECOVERY_OK', receipt: file, databasesUnchanged: true }));
} finally { unlock(); }
