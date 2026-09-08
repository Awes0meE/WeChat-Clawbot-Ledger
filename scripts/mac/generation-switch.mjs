import assert from 'node:assert/strict';
import { storageDecision } from './runtime-controller.mjs';
import { releaseUpdateContract } from '../../deploy/docker/release-update-data.mjs';

export function generationSwitchTemplate(before, after, evidence) {
  for (const key of ['project', 'sourceCommit', 'cutoverId', 'sourceSnapshotSha256', 'importManifestSha256']) assert.equal(after[key], before[key]);
  for (const role of ['origin', 'openclaw', 'guard']) assert.equal(after.services[role].image, before.services[role].image, 'Recovery and image upgrades are separate operations');
  assert.ok(after.volumeGeneration && after.volumeGeneration !== before.volumeGeneration);
  return { version: 1, project: before.project, sourceCommit: before.sourceCommit, cutoverId: before.cutoverId,
    fromGeneration: before.volumeGeneration ?? null, toGeneration: after.volumeGeneration,
    recoverySourceManifestSha256: after.recoverySourceManifestSha256, ...evidence, reviewedAt: null,
    checks: { selectedDataReviewed: false, currentNineVolumesBackedUp: false, allOldVolumesRetained: false,
      uncertainClaimsAndCursorReviewed: false, noCompetingWriter: false, maintenanceUntilExplicitResume: false } };
}
export function validateGenerationSwitch(review, before, after, evidence) {
  const expected = generationSwitchTemplate(before, after, evidence);
  for (const key of Object.keys(expected).filter(k => !['checks', 'reviewedAt'].includes(k))) assert.equal(review?.[key], expected[key], 'Recovery switch binding changed');
  const at = Date.parse(review.reviewedAt ?? '');
  assert.ok(Number.isFinite(at) && at <= Date.now() && Date.now() - at <= 30 * 60000, 'Recovery switch review is not current');
  assert.deepEqual(Object.keys(review.checks ?? {}).sort(), Object.keys(expected.checks).sort());
  assert.ok(Object.keys(expected.checks).every(key => review.checks[key] === true), 'Recovery switch is not reviewed');
}
export function releaseUpdateSwitchTemplate(before, after, evidence) {
  releaseUpdateContract(before, after);
  return { version: 1, operation: 'release-update', project: before.project, cutoverId: before.cutoverId,
    fromSourceCommit: before.sourceCommit, toSourceCommit: after.sourceCommit,
    oldRuntimeImage: before.services.openclaw.image, newRuntimeImage: after.services.openclaw.image,
    oldGuardImage: before.services.guard.image, newGuardImage: after.services.guard.image,
    fromGeneration: before.volumeGeneration ?? null, toGeneration: after.volumeGeneration,
    recoverySourceManifestSha256: after.recoverySourceManifestSha256, ...evidence, reviewedAt: null,
    checks: { currentBackupAndStagedDataMatch: false, exactReleaseCompatibilityVerified: false,
      oldVolumesAndImagesRetained: false, noCompetingWriter: false, maintenanceUntilExplicitResume: false } };
}
export function validateReleaseUpdateSwitch(review, before, after, evidence) {
  const expected = releaseUpdateSwitchTemplate(before, after, evidence);
  for (const key of Object.keys(expected).filter(k => !['checks', 'reviewedAt'].includes(k))) assert.equal(review?.[key], expected[key]);
  const at = Date.parse(review.reviewedAt ?? '');
  assert.ok(Number.isFinite(at) && at <= Date.now() && Date.now() - at <= 30 * 60000);
  assert.deepEqual(Object.keys(review.checks ?? {}).sort(), Object.keys(expected.checks).sort());
  assert.ok(Object.keys(expected.checks).every(key => review.checks[key] === true), 'Release update switch is not reviewed');
}
export async function switchGenerationInMaintenance(options) {
  return switchStoppedRuntime({ ...options, validate: () => validateGenerationSwitch(options.review, options.before, options.after, options.evidence), operation: 'GENERATION' });
}
export async function switchReleaseUpdateInMaintenance(options) {
  return switchStoppedRuntime({ ...options, validate: () => validateReleaseUpdateSwitch(options.review, options.before, options.after, options.evidence), operation: 'RELEASE_UPDATE' });
}
async function switchStoppedRuntime({ before, after, oldDriver, newDriver,
  verifyData, stopHost, selectHost, startHost, checkpoint, validate, operation }) {
  validate();
  const view = await oldDriver.inspect();
  assert.ok(view.available && view.identityValid && view.namespaceValid && Object.values(view.running).every(r => !r));
  assert.ok(await oldDriver.validateInputs()); assert.ok(await newDriver.validateInputs());
  assert.equal(storageDecision(await newDriver.storage(), true), 'ok');
  await verifyData();
  let stopped = false, retired = false, selected = false;
  try {
    await checkpoint('reviewed');
    await stopHost(before); stopped = true;
    await verifyData(); validate();
    await oldDriver.retireStopped(); retired = true; await checkpoint('old-containers-retired-volumes-retained');
    await newDriver.createStopped(); await verifyData(); await checkpoint('new-containers-prepared-stopped');
    await selectHost(after); selected = true;
    await startHost(after); await checkpoint('new-host-loaded-maintenance-remains');
    return { status: `CLAWBOT_${operation}_SELECTED_IN_MAINTENANCE`, businessStarted: false };
  } catch (error) {
    if (!stopped) throw error;
    try {
      // Never roll back once any data or maintenance evidence has changed.
      await verifyData();
      if (selected) await stopHost(after, { allowAbsent: true });
      if (retired) await newDriver.retireStopped({ allowPartial: true });
      else await oldDriver.retireStopped({ allowPartial: true });
      await oldDriver.createStopped(); await selectHost(before); await startHost(before);
      await checkpoint('failed-switch-restored-old-host-in-maintenance');
      return { status: `CLAWBOT_${operation}_SWITCH_ROLLED_BACK_IN_MAINTENANCE`, businessStarted: false };
    } catch {
      await checkpoint('switch-needs-inspection-maintenance-and-volumes-retained');
      throw Error(`CLAWBOT_${operation}_SWITCH_REQUIRES_INSPECTION`);
    }
  }
}
