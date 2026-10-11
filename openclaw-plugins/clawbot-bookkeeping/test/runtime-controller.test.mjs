import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRuntime, storageDecision } from '../../../scripts/mac/runtime-controller.mjs';
const capacity = { hostFreeBytes: 40 * 2 ** 30, volumeFreeBytes: 40 * 2 ** 30 };
const unavailable = kind => ({ error: 'STORAGE_UNAVAILABLE', diagnostic: { kind } });
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
test('Only missing samples and explicitly classified observation failures avoid permanent faults', () => {
  for (const sample of [undefined, unavailable('timeout'), unavailable('daemon-unavailable')]) {
    assert.equal(storageDecision(sample), 'unavailable');
  }
  for (const sample of [null, {}, { error: 'STORAGE_IDENTITY_INVALID' }, { error: 'ENOSPC' },
    unavailable('disk-full'), unavailable('io-error'), unavailable('read-only-filesystem'), unavailable('unclassified'),
    { error: 'STORAGE_UNAVAILABLE' }, { ...capacity, hostFreeBytes: -1 }, { ...capacity, volumeFreeBytes: Infinity }]) {
    assert.equal(storageDecision(sample), 'fault');
  }
});
test('Observation grace expires exactly sixty seconds after a safely sized healthy sample', async () => {
  for (const sample of [undefined, unavailable('timeout'), unavailable('daemon-unavailable')]) {
    const driver = fixture(), state = {};
    assert.equal(await reconcileRuntime(driver, state, { now: 1000, storage: capacity }), 'healthy');
    assert.equal(await reconcileRuntime(driver, state, { now: 60999, storage: sample }), 'storage-observation-grace');
    assert.deepEqual(driver.trace, []);
    assert.equal(await reconcileRuntime(driver, state, { now: 61000, storage: sample }), 'storage-observation-paused');
    assert.deepEqual(driver.trace, ['stop:guard', 'stop:openclaw', 'stop:origin']);
    assert.equal(state.storageFault, undefined);
  }
});
test('Warning or missing samples cannot renew the healthy capacity baseline', async () => {
  const driver = fixture(), state = {};
  await reconcileRuntime(driver, state, { now: 0, storage: capacity });
  assert.equal(await reconcileRuntime(driver, state, { now: 40000, storage: { ...capacity, hostFreeBytes: 7 * 2 ** 30 } }), 'healthy-low-disk');
  assert.equal(await reconcileRuntime(driver, state, { now: 59000 }), 'storage-observation-grace');
  assert.equal(state.healthyStorageAt, 0);
  assert.equal(await reconcileRuntime(driver, state, { now: 60000 }), 'storage-observation-paused');
});
test('Unknown capacity without a healthy baseline pauses immediately and cannot initiate recovery', async () => {
  for (const patch of [{}, { healthy: false, namespaceValid: false }]) {
    const driver = fixture(patch), state = {};
    assert.equal(await reconcileRuntime(driver, state, { now: 0 }), 'storage-observation-paused');
    assert.deepEqual(driver.trace, ['stop:guard', 'stop:openclaw', 'stop:origin']);
    assert.equal(state.storageFault, undefined);
  }
  const driver = fixture(), state = {};
  await reconcileRuntime(driver, state, { now: 0, storage: { ...capacity, volumeFreeBytes: 3 * 2 ** 30 } });
  assert.equal(await reconcileRuntime(driver, state, { now: 1 }), 'storage-observation-paused');
});
test('Grace requires the original three healthy containers and a valid namespace', async () => {
  for (const change of [d => { d.view.trusted.openclaw = 'replacement'; }, d => { d.view.healthy = false; },
    d => { d.view.namespaceValid = false; }]) {
    const driver = fixture(), state = {};
    await reconcileRuntime(driver, state, { now: 100, storage: capacity });
    change(driver);
    assert.equal(await reconcileRuntime(driver, state, { now: 101, storage: unavailable('timeout') }), 'storage-observation-paused');
    assert.ok(!driver.trace.some(item => item.startsWith('start:')));
  }
});
test('Sustained observation failure pauses without latching and only fresh safe capacity permits recovery', async () => {
  const driver = fixture(), state = {};
  driver.stop = async role => {
    driver.trace.push(`stop:${role}`); driver.view.running[role] = false;
    driver.view.ready[role] = false; driver.view.healthy = false;
  };
  await reconcileRuntime(driver, state, { now: 0, storage: capacity });
  assert.equal(await reconcileRuntime(driver, state, { now: 60000, storage: unavailable('timeout') }), 'storage-observation-paused');
  driver.trace.length = 0;
  assert.equal(await reconcileRuntime(driver, state, { now: 60001, storage: unavailable('timeout') }), 'storage-observation-paused');
  assert.ok(!driver.trace.some(item => item.startsWith('start:') || item === 'latch'));
  assert.equal(await reconcileRuntime(driver, state, { now: 60002, storage: { ...capacity, hostFreeBytes: 7 * 2 ** 30 } }), 'stopped-low-disk');
  driver.trace.length = 0;
  assert.equal(await reconcileRuntime(driver, state, { now: 60003, storage: capacity }), 'healthy');
  assert.deepEqual(driver.trace, ['stop:guard', 'stop:openclaw', 'stop:origin', 'start:origin:false', 'ready:origin',
    'start:openclaw:true', 'ready:openclaw', 'start:guard:true', 'ready:guard']);
  assert.equal(state.storageStopped, false);
  assert.equal(state.storageFault, undefined);
});
test('Existing permanent faults and real low space override any prior healthy baseline', async () => {
  for (const sample of [undefined, unavailable('timeout'), capacity]) {
    const driver = fixture(), state = { storageFault: true, healthyStorageAt: 0, healthyStorageContainers: ['g', 'w', 'o'] };
    assert.equal(await reconcileRuntime(driver, state, { now: 1, storage: sample }), 'storage-fault-latched');
    assert.equal(state.storageFault, true);
    assert.deepEqual(driver.trace, ['stop:guard', 'stop:openclaw', 'stop:origin']);
  }
  const driver = fixture(), state = {};
  await reconcileRuntime(driver, state, { now: 0, storage: capacity });
  assert.equal(await reconcileRuntime(driver, state, { now: 1, storage: { ...capacity, volumeFreeBytes: 2 ** 30 } }), 'stopped-low-disk');
  assert.deepEqual(driver.trace, ['stop:guard', 'stop:openclaw', 'stop:origin']);
});
test('Maintenance and identity checks retain priority over observation policy', async () => {
  const maintenance = fixture();
  maintenance.inspect = async () => { throw Error('maintenance must not inspect'); };
  assert.equal(await reconcileRuntime(maintenance, {}, { maintenance: true }), 'maintenance');
  assert.deepEqual(maintenance.trace, []);
  const identity = fixture({ identityValid: false, trusted: { guard: 'g', openclaw: 'w' } });
  assert.equal(await reconcileRuntime(identity, {}, {}), 'identity-needs-attention');
  assert.deepEqual(identity.trace, ['stop:guard', 'stop:openclaw']);
  const activation = fixture(); activation.validateInputs = async () => false;
  assert.equal(await reconcileRuntime(activation, {}, {}), 'activation-needs-attention');
  assert.deepEqual(activation.trace, ['stop:guard', 'stop:openclaw']);
});
test('A supplied inspection is reused, avoiding a second-inspection missing-sample race', async () => {
  const driver = fixture(); driver.inspect = async () => { throw Error('unexpected second inspection'); };
  assert.equal(await reconcileRuntime(driver, {}, { view: { available: false, trusted: {} } }), 'waiting-for-docker');
  assert.deepEqual(driver.trace, []);
  assert.equal(await reconcileRuntime(driver, {}, { view: driver.view, storage: capacity }), 'healthy');
});
test('A backwards clock cannot prolong observation grace', async () => {
  const driver = fixture(), state = {};
  await reconcileRuntime(driver, state, { now: 100, storage: capacity });
  assert.equal(await reconcileRuntime(driver, state, { now: 99 }), 'storage-observation-paused');
});
test('Partial measurements retain low-space protection while hard errors and malformed values still latch', () => {
  for (const kind of ['timeout', 'daemon-unavailable']) {
    assert.equal(storageDecision({ ...unavailable(kind), hostFreeBytes: 4 * 2 ** 30 }), 'stop');
    assert.equal(storageDecision({ ...unavailable(kind), volumeFreeBytes: 2 ** 30 }), 'stop');
    assert.equal(storageDecision({ ...unavailable(kind), hostFreeBytes: 40 * 2 ** 30 }), 'unavailable');
    assert.equal(storageDecision({ ...unavailable(kind), volumeFreeBytes: NaN }), 'fault');
    assert.equal(storageDecision({ ...unavailable(kind), hostFreeBytes: -1 }), 'fault');
  }
  assert.equal(storageDecision({ ...unavailable('disk-full'), hostFreeBytes: 0 }), 'fault');
  assert.equal(storageDecision({ error: 'STORAGE_IDENTITY_INVALID', hostFreeBytes: 0 }), 'fault');
});
test('Slow validation consumes grace instead of extending it', async t => {
  const driver = fixture(), state = {}; let clock = 1000;
  t.mock.method(Date, 'now', () => clock);
  driver.validateInputs = async () => { clock += 30000; return true; };
  assert.equal(await reconcileRuntime(driver, state, { storage: capacity }), 'healthy');
  assert.equal(state.healthyStorageAt, 1000);
  assert.equal(await reconcileRuntime(driver, state, { storage: unavailable('timeout') }), 'storage-observation-paused');
  assert.deepEqual(driver.trace, ['stop:guard', 'stop:openclaw', 'stop:origin']);
});
