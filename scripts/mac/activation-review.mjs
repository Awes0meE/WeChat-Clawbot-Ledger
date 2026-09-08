export const ACTIVATION_CHECKS = Object.freeze(['windowsReceiverStopped', 'windowsTunnelStopped', 'windowsLedgerStopped',
  'finalWindowsSnapshotVerified', 'officialModelAuthorizationChecked', 'currentOwnerAndCursorReviewed', 'singleWriterCutoverReviewed']);
export function activationReviewTemplate(spec) {
  return { version: 1, project: 'clawbot-production', sourceCommit: spec.sourceCommit, cutoverId: spec.cutoverId,
    sourceSnapshotSha256: spec.sourceSnapshotSha256, importManifestSha256: spec.importManifestSha256,
    runtimeImage: spec.services.openclaw.image, guardImage: spec.services.guard.image, volumeGeneration: spec.volumeGeneration ?? null,
    recoverySourceManifestSha256: spec.recoverySourceManifestSha256 ?? null, reviewedAt: null,
    checks: Object.fromEntries(ACTIVATION_CHECKS.map((name) => [name, false])) };
}
export function validateActivationReview(review, spec, now = Date.now()) {
  const template = activationReviewTemplate(spec);
  for (const key of ['version', 'project', 'sourceCommit', 'cutoverId', 'sourceSnapshotSha256', 'importManifestSha256', 'runtimeImage', 'guardImage', 'volumeGeneration', 'recoverySourceManifestSha256']) {
    if (review?.[key] !== template[key]) throw Error('CLAWBOT_ACTIVATION_REVIEW_BINDING');
  }
  const at = Date.parse(review.reviewedAt ?? '');
  if (!Number.isFinite(at) || at > now || now - at > 30 * 60000) throw Error('CLAWBOT_ACTIVATION_REVIEW_FRESHNESS');
  if (JSON.stringify(Object.keys(review.checks ?? {}).sort()) !== JSON.stringify([...ACTIVATION_CHECKS].sort())
    || !ACTIVATION_CHECKS.every((name) => review.checks[name] === true)) throw Error('CLAWBOT_ACTIVATION_REVIEW_INCOMPLETE');
  return true;
}
