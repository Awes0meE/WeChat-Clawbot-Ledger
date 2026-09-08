import test from 'node:test';
import assert from 'node:assert/strict';
import { activationReviewTemplate, validateActivationReview } from '../../../scripts/mac/activation-review.mjs';
test('First activation requires a fresh reviewed cutover bound to source, import and both images', () => {
  const spec = { sourceCommit: 'a'.repeat(40), cutoverId: 'fixture', sourceSnapshotSha256: 'b'.repeat(64),
    importManifestSha256: 'c'.repeat(64), services: { openclaw: { image: `sha256:${'d'.repeat(64)}` }, guard: { image: `sha256:${'e'.repeat(64)}` } } };
  const now = Date.now(), template = activationReviewTemplate(spec);
  assert.ok(Object.values(template.checks).every((value) => value === false)); assert.throws(() => validateActivationReview(template, spec, now));
  const valid = () => ({ ...template, reviewedAt: new Date(now).toISOString(), checks: Object.fromEntries(Object.keys(template.checks).map((name) => [name, true])) });
  assert.equal(validateActivationReview(valid(), spec, now), true);
  for (const change of [(r) => r.checks.windowsReceiverStopped = false, (r) => delete r.checks.officialModelAuthorizationChecked,
    (r) => r.importManifestSha256 = 'x', (r) => r.runtimeImage = 'x', (r) => r.sourceCommit = 'x',
    (r) => r.reviewedAt = new Date(now - 1800001).toISOString(), (r) => r.reviewedAt = new Date(now + 1).toISOString()]) {
    const review = valid(); change(review); assert.throws(() => validateActivationReview(review, spec, now));
  }
});
