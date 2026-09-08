import { storageDecision } from './runtime-controller.mjs';

export const STORAGE_RECOVERY_CHECKS = Object.freeze(['storageCauseResolved', 'allNineVolumesBackedUp',
  'ledgerAndReceiptsReviewed', 'unresolvedClaimsPreserved', 'confirmationsAndCursorReviewed',
  'noCompetingWriter', 'currentDataSelectedWithoutRollback']);
export function storageRecoveryTemplate(spec, evidence) {
  return { version: 1, project: spec.project, sourceCommit: spec.sourceCommit, cutoverId: spec.cutoverId,
    importManifestSha256: spec.importManifestSha256, volumeGeneration: spec.volumeGeneration ?? null, ...evidence, reviewedAt: null,
    checks: Object.fromEntries(STORAGE_RECOVERY_CHECKS.map(name => [name, false])) };
}
export function validateStorageRecoveryReview(review, spec, evidence, now = Date.now()) {
  const expected = storageRecoveryTemplate(spec, evidence);
  for (const key of ['version', 'project', 'sourceCommit', 'cutoverId', 'importManifestSha256', 'volumeGeneration', ...Object.keys(evidence)]) {
    if (review?.[key] !== expected[key]) throw Error('CLAWBOT_STORAGE_REVIEW_BINDING');
  }
  const at = Date.parse(review.reviewedAt ?? '');
  if (!Number.isFinite(at) || at > now || now - at > 30 * 60000) throw Error('CLAWBOT_STORAGE_REVIEW_FRESHNESS');
  if (JSON.stringify(Object.keys(review.checks ?? {}).sort()) !== JSON.stringify([...STORAGE_RECOVERY_CHECKS].sort())
    || !STORAGE_RECOVERY_CHECKS.every(name => review.checks[name] === true)) throw Error('CLAWBOT_STORAGE_REVIEW_INCOMPLETE');
}

// Caller holds the operation lock and a matching maintenance marker. Stop the
// validated host before removing its persistent fault so its in-memory latch
// cannot survive and maintenance cannot accidentally resume an old process.
export async function clearReviewedStorageFault({ driver, review, spec, evidence, verifyEvidence,
  stopHost, archiveAndClear, restartHost }) {
  const preflight = async () => {
    validateStorageRecoveryReview(review, spec, evidence);
    const view = await driver.inspect();
    if (!view.available || !view.identityValid || !view.namespaceValid
      || Object.values(view.running).some(Boolean)) throw Error('CLAWBOT_STORAGE_RECOVERY_NOT_QUIESCENT');
    if (!await driver.validateInputs() || storageDecision(await driver.storage(), true) !== 'ok') throw Error('CLAWBOT_STORAGE_RECOVERY_INPUTS');
    await verifyEvidence();
  };
  await preflight();
  await stopHost();
  await preflight();
  await archiveAndClear();
  // Maintenance remains present. This restarts only the host process, never
  // starts services, removes claims or selects a different database snapshot.
  await restartHost();
}
