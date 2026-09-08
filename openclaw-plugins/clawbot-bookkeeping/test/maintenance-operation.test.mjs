import test from 'node:test';
import assert from 'node:assert/strict';
import { enterMaintenance, leaveMaintenance } from '../../../scripts/mac/maintenance-operation.mjs';
test('Maintenance records pause before ordered stop and preserves it after partial failure', async () => {
  const actions = [], driver = { inspect: async () => ({ available: true, identityValid: true,
    trusted: { guard: 'g', openclaw: 'w', origin: 'o' } }),
    stop: async (role) => { actions.push(role); if (role === 'openclaw') throw Error('stop failed'); } };
  await assert.rejects(enterMaintenance(driver, () => actions.push('pause')));
  assert.deepEqual(actions, ['pause', 'guard', 'openclaw']);
});
test('Maintenance cannot be used to bypass a storage fault, unknown identity, invalid inputs or low recovery reserve', async () => {
  let removed = false;
  const driver = { inspect: async () => ({ available: true, identityValid: true }),
    storage: async () => ({ hostFreeBytes: 20 * 2 ** 30, volumeFreeBytes: 10 * 2 ** 30 }), validateInputs: async () => true };
  const remove = () => { removed = true; };
  await assert.rejects(leaveMaintenance(driver, { storageFault: true, remove })); assert.equal(removed, false);
  for (const replacement of [{ inspect: async () => ({ available: true, identityValid: false }) },
    { validateInputs: async () => false }, { storage: async () => ({ hostFreeBytes: 6 * 2 ** 30, volumeFreeBytes: 3 * 2 ** 30 }) }]) {
    await assert.rejects(leaveMaintenance({ ...driver, ...replacement }, { storageFault: false, remove })); assert.equal(removed, false);
  }
  await leaveMaintenance(driver, { storageFault: false, remove }); assert.equal(removed, true);
});
