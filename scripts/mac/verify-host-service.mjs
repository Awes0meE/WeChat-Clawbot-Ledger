import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireOperationLock, operationsRoot } from './operation-lock.mjs';
import { verifyTestHost } from './verify-test-host.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const env = { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}` };
const compose = ['compose', '-f', 'deploy/docker/compose.test.yml'];
function run(args) {
  const result = spawnSync(docker, args, { cwd: root, env, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('CLAWBOT_HOST_RECOVERY_VERIFICATION_FAILED');
  return result.stdout;
}
const status = () => JSON.parse(readFileSync(join(operationsRoot, 'host-status.json')));
assert.ok(!existsSync(join(operationsRoot, 'maintenance')), 'Maintenance mode is active');
const initial = status();
assert.ok(initial.state === 'healthy' && Date.now() - Date.parse(initial.updatedAt) < 45000);
assert.match(initial.sourceCommit, /^[a-f0-9]{40}$/);
const release = JSON.parse(readFileSync(join(homedir(), 'Library', 'Application Support', 'Clawbot', 'host-releases', initial.sourceCommit, 'release-runtime.json')));
const unlock = acquireOperationLock('host-recovery-verification');
let startedAt;
try {
  verifyTestHost({ runtimeImage: release.runtimeImage });
  const ids = run(['ps', '-q', '--filter', 'label=com.docker.compose.project=clawbot-test']).trim().split('\n').filter(Boolean);
  const containers = JSON.parse(run(['inspect', ...ids]));
  assert.ok(containers.length === 2 && containers.every((c) => ['origin', 'openclaw'].includes(c.Config.Labels['com.docker.compose.service'])));
  run([...compose, 'stop', 'openclaw', 'origin']);
  run([...compose, 'run', '--rm', '-T', '--no-deps', '--entrypoint', 'node', 'init', '/opt/clawbot/docker/verify-state.mjs', 'save']);
  startedAt = Date.now();
} finally { unlock(); }
// Do not issue 'up': only the installed host agent is allowed to recover this
// fault, otherwise the test would pass without exercising automatic recovery.
let recovered = false;
while (Date.now() - startedAt < 150000) {
  const current = status();
  if (current.state === 'healthy' && Date.parse(current.updatedAt) >= startedAt) {
    verifyTestHost({ runtimeImage: release.runtimeImage }); recovered = true; break;
  }
  await delay(1000);
}
assert.ok(recovered, 'Installed host service did not recover the stopped pair');
const checkUnlock = acquireOperationLock('host-recovery-data-check');
try { run([...compose, 'run', '--rm', '-T', '--no-deps', '--entrypoint', 'node', 'init', '/opt/clawbot/docker/verify-state.mjs', 'check']); }
finally { checkUnlock(); }
console.log(JSON.stringify({ status: 'CLAWBOT_INSTALLED_HOST_AUTO_RECOVERY_OK', dataUnchanged: true,
  recoveredWithinSeconds: Math.ceil((Date.now() - startedAt) / 1000) }));
