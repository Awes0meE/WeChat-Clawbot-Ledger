import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireOperationLock } from './operation-lock.mjs';
import { verifyTestHost } from './verify-test-host.mjs';

const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
function run(args) {
  const result = spawnSync(docker, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error('CLAWBOT_NETWORK_CHECK_FAILED');
  return result.stdout.trim();
}
const unlock = acquireOperationLock('network-verification');
let detached = false, origin;
try {
  const checked = verifyTestHost(); origin = checked.origin;
  const network = JSON.parse(run(['network', 'inspect', 'clawbot-test_default']))[0];
  assert.deepEqual(Object.keys(network.Containers), [origin], 'Unexpected member of the isolated network');
  function reachable(url) {
    return run(['exec', checked.openclaw, 'node', '--input-type=module', '-e',
      'try{await fetch(process.argv[1],{signal:AbortSignal.timeout(4000),redirect:"manual"});console.log("yes")}catch{console.log("no")}', url]) === 'yes';
  }
  assert.equal(reachable('https://chatgpt.com/'), true, 'Upstream transport unavailable before fault');
  detached = true; run(['network', 'disconnect', 'clawbot-test_default', origin]);
  assert.equal(reachable('https://chatgpt.com/'), false, 'Fault did not isolate outbound transport');
  assert.equal(reachable('http://127.0.0.1:18888/healthz.json'), true, 'Local ledger should retain its shared loopback');
  run(['network', 'connect', 'clawbot-test_default', origin]); detached = false;
  let resumed = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (reachable('https://chatgpt.com/')) { resumed = true; break; }
    await delay(1000);
  }
  assert.ok(resumed, 'Outbound transport did not recover'); verifyTestHost();
  console.log('CLAWBOT_TEST_OUTBOUND_NETWORK_RECOVERY_OK');
} finally {
  // Never change host Wi-Fi, production namespaces or unrelated networks.
  if (detached) run(['network', 'connect', 'clawbot-test_default', origin]);
  unlock();
}
