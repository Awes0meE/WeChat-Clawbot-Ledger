import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { releaseUpdateContract } from '../../deploy/docker/release-update-data.mjs';
export function releaseUpdateStageTemplate(before, after, candidate) {
  releaseUpdateContract(before, after);
  assert.equal(candidate.runtimeImage, before.services.openclaw.image);
  assert.equal(candidate.sourceVolumeGeneration ?? null, before.volumeGeneration ?? null);
  return { version: 1, operation: 'release-update', project: before.project,
    fromSourceCommit: before.sourceCommit, toSourceCommit: after.sourceCommit,
    oldRuntimeImage: before.services.openclaw.image, newRuntimeImage: after.services.openclaw.image,
    oldGuardImage: before.services.guard.image, newGuardImage: after.services.guard.image,
    cutoverId: after.cutoverId, importManifestSha256: after.importManifestSha256,
    fromGeneration: before.volumeGeneration ?? null, toGeneration: after.volumeGeneration,
    sourceArchiveManifestSha256: after.recoverySourceManifestSha256, candidateProject: candidate.project,
    dataAuditSha256: createHash('sha256').update(JSON.stringify(candidate.audit)).digest('hex'), reviewedAt: null,
    checks: { exactReleaseDiffAndTestsReviewed: false, fixedUpstreamAndDataCompatibilityVerified: false,
      currentBackupSelected: false, oldVolumesAndImagesRetained: false, offlineStagingOnly: false } };
}
export function validateReleaseUpdateStage(review, before, after, candidate) {
  const template = releaseUpdateStageTemplate(before, after, candidate);
  for (const key of Object.keys(template).filter(k => !['reviewedAt', 'checks'].includes(k))) assert.equal(review?.[key], template[key]);
  const at = Date.parse(review.reviewedAt ?? '');
  assert.ok(Number.isFinite(at) && at <= Date.now() && Date.now() - at <= 30 * 60000);
  assert.deepEqual(Object.keys(review.checks ?? {}).sort(), Object.keys(template.checks).sort());
  assert.ok(Object.keys(template.checks).every(k => review.checks[k] === true), 'Release update staging not reviewed');
}

export function validateReleaseUpdateSelection(stage, before, after, currentManifest, currentManifestSha256) {
  releaseUpdateContract(before, after);
  assert.equal(stage.status, 'CLAWBOT_RELEASE_UPDATE_GENERATION_STAGED');
  assert.equal(stage.productionActivated, false); assert.equal(stage.productionInputsVerified, true);
  assert.equal(stage.filesPreservedExceptSourceBindings, true);
  assert.equal(stage.previousSourceCommit, before.sourceCommit); assert.equal(stage.previousRuntimeImage, before.services.openclaw.image);
  assert.equal(stage.runtimeImage, after.services.openclaw.image); assert.equal(stage.guardImage, after.services.guard.image);
  assert.equal(after.recoverySourceManifestSha256, currentManifestSha256, 'An update must derive from the current backup, not historical data');
  assert.equal(stage.recoverySourceManifestSha256, currentManifestSha256);
  assert.deepEqual(stage.sourceAudit, currentManifest.audit);
  assert.deepEqual(stage.stagedAudit.databases, currentManifest.audit.databases, 'The update cannot transform either database');
}
