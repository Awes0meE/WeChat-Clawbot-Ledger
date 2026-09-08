import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRuntime, storageDecision } from '../../../scripts/mac/runtime-controller.mjs';
const capacity = { hostFreeBytes: 40 * 2 ** 30, volumeFreeBytes: 40 * 2 ** 30 };
function fixture(patch = {}) {
  const trace = [], view = { available: true, identityValid: true, namespaceValid: true, healthy: true,
    trusted: { guard: 'g', openclaw: 'w', origin: 'o' }, ready: { guard: true, openclaw: true, origin: true },
    running: { guard: true, openclaw: true, origin: true }, ...patch };
  return { trace, view, inspect: async () => view, validateInputs: async () => true,
    latchStorageFault: async () => trace.push('latch'), stop: async (role) => trace.push(`stop:${role}`),
    start: async (role, rebind) => { trace.push(`start:${role}:${rebind}`); view.ready[role] = true;
      view.running[role] = true; if (role === 'guard') { view.healthy = true; view.namespaceValid = true; } },
    requireReady: async (role) => trace.push(`ready:${role}`) };
}
test('Storage hysteresis requires both the Mac and the Docker volume to recover', () => {
  assert.equal(storageDecision(capacity), 'ok');
  assert.equal(storageDecision({ ...capacity, volumeFreeBytes: 2 ** 30 }), 'stop');
  assert.equal(storageDecision({ ...capacity, hostFreeBytes: 7 * 2 ** 30 }, true), 'hold');
  assert.equal(storageDecision({ ...capacity, hostFreeBytes: 7 * 2 ** 30 }), 'warn');
  assert.equal(storageDecision({ ...capacity, volumeFreeBytes: NaN }), 'fault');
});
test('Disk write/measurement errors close ingress before the ledger and persist a latch', async () => {
  const driver = fixture(), state = {};
  assert.equal(await reconcileRuntime(driver, state, { storage: { error: 'ENOSPC' } }), 'storage-fault-latched');
  assert.deepEqual(driver.trace, ['latch', 'stop:guard', 'stop:openclaw', 'stop:origin']);
  driver.trace.length = 0;
  assert.equal(await reconcileRuntime(driver, state, { storage: capacity }), 'storage-fault-latched');
  assert.deepEqual(driver.trace, ['stop:guard', 'stop:openclaw', 'stop:origin']);
});
test('Namespace replacement rebinds both dependants and opens the publisher last', async () => {
  const driver = fixture({ namespaceValid: false });
  assert.equal(await reconcileRuntime(driver, {}, { storage: capacity }), 'healthy');
  assert.deepEqual(driver.trace, ['stop:guard', 'stop:openclaw', 'ready:origin', 'start:openclaw:true',
    'ready:openclaw', 'start:guard:true', 'ready:guard']);
});
test('Unknown origin closes only recognized ingress and cannot be restarted', async () => {
  const driver = fixture({ identityValid: false, trusted: { guard: 'g', openclaw: 'w' } });
  assert.equal(await reconcileRuntime(driver, {}, { storage: capacity }), 'identity-needs-attention');
  assert.deepEqual(driver.trace, ['stop:guard', 'stop:openclaw']);
});
test('Failed readiness never opens the publisher, and a transient Tunnel outage does not restart data services', async () => {
  const failed = fixture({ healthy: false, ready: { origin: false, openclaw: false, guard: false } });
  failed.requireReady = async () => { throw new Error('Not ready'); };
  assert.equal(await reconcileRuntime(failed, {}, { storage: capacity }), 'recovery-needs-attention');
  assert.ok(!failed.trace.some((item) => item.startsWith('start:guard')));
  const network = fixture({ healthy: false });
  assert.equal(await reconcileRuntime(network, {}, { storage: capacity }), 'guard-unready');
  assert.deepEqual(network.trace, []);
});
