import test from 'node:test';
import assert from 'node:assert/strict';
import { switchDashboard } from '../../../scripts/mac/dashboard-switch.mjs';

function fixture(failAt, unknown = false) {
  const state = { previous: true, next: false, listener: 'previous', locked: false, records: [], changed: false };
  let failed = false;
  const fault = name => { if (failAt === name && !failed) { failed = true; throw Error('injected'); } };
  const actions = {
    preflight: () => { state.locked = true; fault('preflight'); },
    record: name => { fault(name); state.records.push(name); },
    retirePrevious: () => { fault('before-retire'); state.previous = false; state.listener = unknown ? 'unknown' : null; fault('after-retire'); },
    assertVacant: () => assert.equal(state.listener, null),
    installNext: () => { state.next = true; fault('after-install'); state.listener = 'next'; },
    releaseLock: () => { state.locked = false; },
    acquireLock: () => { state.locked = true; },
    verifyNext: () => { assert.equal(state.locked, false); assert.equal(state.listener, 'next'); fault('verify-next'); },
    verifyProductionUnchanged: () => { assert.equal(state.changed, false); fault('production-check'); },
    removeNextIfOwned: () => { state.next = false; if (state.listener === 'next') state.listener = null; },
    restorePrevious: () => { assert.ok([null, 'previous'].includes(state.listener)); state.previous = true; state.listener = 'previous'; },
    verifyPrevious: () => { assert.equal(state.locked, false); assert.equal(state.listener, 'previous'); },
  };
  return { state, actions };
}
test('successful switch retires the previous task only after its journal exists and releases the operation lock', async () => {
  const { state, actions } = fixture();
  const retire = actions.retirePrevious;
  actions.retirePrevious = () => { assert.deepEqual(state.records, ['started']); retire(); };
  assert.equal((await switchDashboard(actions)).status, 'CLAWBOT_DASHBOARD_SWITCHED');
  assert.deepEqual(state.records, ['started', 'completed']);
  assert.equal(state.previous, false); assert.equal(state.next, true); assert.equal(state.locked, false);
});
test('preflight and journal failures leave the current task and listener intact', async () => {
  for (const failure of ['preflight', 'started']) {
    const { state, actions } = fixture(failure);
    await assert.rejects(switchDashboard(actions), /injected/);
    assert.equal(state.previous, true); assert.equal(state.listener, 'previous'); assert.equal(state.next, false);
    assert.equal(state.locked, false);
  }
});
test('failure before or during retirement, after installation, readiness or final recording restores the previous task', async () => {
  for (const failure of ['before-retire', 'after-retire', 'after-install', 'verify-next', 'production-check', 'completed']) {
    const { state, actions } = fixture(failure);
    assert.equal((await switchDashboard(actions)).status, 'CLAWBOT_DASHBOARD_PREVIOUS_RESTORED', failure);
    assert.equal(state.previous, true); assert.equal(state.next, false); assert.equal(state.locked, false);
    assert.equal(state.listener, 'previous'); assert.deepEqual(state.records, ['started', 'rolled-back']);
  }
});
test('an unknown listener is preserved and reported for attention instead of being killed or claiming recovery', async () => {
  const { state, actions } = fixture(undefined, true);
  await assert.rejects(switchDashboard(actions), /CLAWBOT_DASHBOARD_SWITCH_NEEDS_ATTENTION/);
  assert.equal(state.listener, 'unknown'); assert.equal(state.next, false); assert.equal(state.locked, false);
  assert.deepEqual(state.records, ['started', 'needs-attention']);
});
test('persistent production changes do not get reported as an unchanged successful rollback', async () => {
  const { state, actions } = fixture();
  actions.verifyProductionUnchanged = () => { throw Error('changed'); };
  await assert.rejects(switchDashboard(actions), /NEEDS_ATTENTION/);
  assert.equal(state.listener, 'previous'); assert.equal(state.records.at(-1), 'needs-attention');
});
