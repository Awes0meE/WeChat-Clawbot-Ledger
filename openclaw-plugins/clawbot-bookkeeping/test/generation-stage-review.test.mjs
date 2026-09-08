import test from 'node:test';
import assert from 'node:assert/strict';
import { generationStageTemplate, validateGenerationStageReview } from '../../../scripts/mac/generation-stage-review.mjs';
const spec = { project: 'clawbot-production', volumeGeneration: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  sourceCommit: 'a'.repeat(40), cutoverId: '11111111-2222-3333-4444-555555555555', importManifestSha256: 'b'.repeat(64), recoverySourceManifestSha256: 'c'.repeat(64) };
const candidate = { project: 'clawbot-recovery-123456abcdef', audit: { inventorySha256: 'd'.repeat(64) } };
test('staging review binds one candidate, archive, generation and audited data', () => {
  const review = generationStageTemplate(spec, candidate);
  assert.throws(() => validateGenerationStageReview(review, spec, candidate));
  review.reviewedAt = new Date().toISOString();
  assert.throws(() => validateGenerationStageReview(review, spec, candidate));
  for (const key of Object.keys(review.checks)) review.checks[key] = true;
  validateGenerationStageReview(review, spec, candidate);
  for (const patch of [{ candidateProject: 'clawbot-recovery-fedcba654321' }, { recoverySourceManifestSha256: 'e'.repeat(64) },
    { volumeGeneration: spec.cutoverId }, { reviewedAt: new Date(Date.now() - 31 * 60000).toISOString() },
    { reviewedAt: new Date(Date.now() + 60000).toISOString() }, { checks: { ...review.checks, unexpected: true } }]) {
    assert.throws(() => validateGenerationStageReview({ ...review, ...patch }, spec, candidate));
  }
  assert.throws(() => validateGenerationStageReview(review, spec, { ...candidate, audit: { inventorySha256: 'f'.repeat(64) } }));
});
