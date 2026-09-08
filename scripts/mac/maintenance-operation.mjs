import { storageDecision } from './runtime-controller.mjs';
export async function enterMaintenance(driver, persist) {
  const view = await driver.inspect();
  if (!view.available || !view.identityValid) throw new Error('CLAWBOT_MAINTENANCE_IDENTITY');
  // Write the pause before stopping anything. A failed partial stop must not
  // make the host start ingestion again while an operator is checking it.
  await persist();
  for (const role of ['guard', 'openclaw', 'origin']) {
    if (!view.trusted[role]) throw new Error('CLAWBOT_MAINTENANCE_HANDLE');
    await driver.stop(role, view.trusted[role]);
  }
  const after = await driver.inspect();
  if (!after.identityValid || Object.values(after.running).some(Boolean)) throw new Error('CLAWBOT_MAINTENANCE_NOT_STOPPED');
}
export async function leaveMaintenance(driver, { storageFault, remove }) {
  if (storageFault) throw new Error('CLAWBOT_MAINTENANCE_RECONCILIATION_REQUIRED');
  const view = await driver.inspect();
  if (!view.available || !view.identityValid) throw new Error('CLAWBOT_MAINTENANCE_IDENTITY');
  if (storageDecision(await driver.storage(), true) !== 'ok') throw new Error('CLAWBOT_MAINTENANCE_STORAGE');
  if (!await driver.validateInputs()) throw new Error('CLAWBOT_MAINTENANCE_INPUTS');
  await remove(); // The regular host, not this command, owns restart ordering.
}
