import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireOperationLock } from './operation-lock.mjs';
acquireOperationLock('recovery-verification');

const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const env = { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}` };
const compose = ['compose', '-f', 'deploy/docker/compose.test.yml'];
function run(args, timeout = 180_000) {
  const result = spawnSync(docker, args, { cwd: root, env, encoding: 'utf8', timeout });
  if (result.status !== 0) throw new Error(`CLAWBOT_RECOVERY_STEP_FAILED:${args[0]}:${args[1]}`);
  return result.stdout;
}
function checkHost() {
  const result = spawnSync(process.execPath, ['scripts/mac/verify-test-host.mjs'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, 'Test host isolation check failed');
}
function state(mode) {
  run([...compose, '--profile', 'setup', 'run', '--rm', '-T', '--entrypoint', 'node', 'init', '/opt/clawbot/docker/verify-state.mjs', mode]);
}
function up() { run([...compose, 'up', '-d', '--wait', '--wait-timeout', '120', 'origin', 'openclaw']); }
function verify(label) {
  state('check'); checkHost();
  run([...compose, '--profile', 'tools', 'run', '--rm', '-T', 'cli']);
  console.log(`CLAWBOT_RECOVERY_OK:${label}`);
}
checkHost();
// Stop only the validated project. No volume is removed or restored.
run([...compose, 'stop', 'openclaw', 'origin']); state('save');
run([...compose, 'start', 'origin']); up(); verify('origin-stop-start');
run([...compose, 'stop', 'openclaw', 'origin']); state('save');
const oldOrigin = run([...compose, 'ps', '-a', '-q', 'origin']).trim();
run([...compose, 'rm', '-f', 'openclaw', 'origin']); up();
assert.notEqual(run([...compose, 'ps', '-q', 'origin']).trim(), oldOrigin);
verify('origin-and-gateway-recreated');
// VM restart is allowed only when every remaining running container belongs to
// this test. Refuse to interrupt an unrelated user's workload.
const all = run(['ps', '-q']).trim().split('\n').filter(Boolean);
for (const id of all) {
  const c = JSON.parse(run(['inspect', id]))[0];
  assert.ok(c.Config.Labels?.['com.docker.compose.project'] === 'clawbot-test'
    && ['origin', 'openclaw'].includes(c.Config.Labels?.['com.docker.compose.service']), 'Other running workload; refusing VM restart');
}
run([...compose, 'stop', 'openclaw', 'origin']); state('save');
console.log('CLAWBOT_RECOVERY_VM_RESTART_BEGIN');
run(['desktop', 'stop', '--timeout', '45'], 55_000);
run(['desktop', 'start', '--timeout', '45'], 55_000);
up(); verify('docker-vm-restarted');
console.log('CLAWBOT_TEST_RECOVERY_MATRIX_OK');
