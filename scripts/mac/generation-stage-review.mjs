import { createHash } from 'node:crypto';
import { generationReceipt } from '../../deploy/docker/generation-receipts.mjs';
export function generationStageTemplate(spec, candidate) {
  return { ...generationReceipt(spec), candidateProject: candidate.project,
    dataAuditSha256: createHash('sha256').update(JSON.stringify(candidate.audit)).digest('hex'), reviewedAt: null,
    checks: { selectedArchiveReviewed: false, currentDataPreserved: false, uncertainClaimsReviewed: false, offlineStagingOnly: false } };
}
export function validateGenerationStageReview(review, spec, candidate) {
  const expected = generationStageTemplate(spec, candidate);
  for (const key of Object.keys(expected).filter(key => !['reviewedAt', 'checks'].includes(key))) {
    if (review?.[key] !== expected[key]) throw Error('CLAWBOT_GENERATION_REVIEW_BINDING');
  }
  const at = Date.parse(review.reviewedAt ?? '');
  if (!Number.isFinite(at) || at > Date.now() || Date.now() - at > 30 * 60000) throw Error('CLAWBOT_GENERATION_REVIEW_FRESHNESS');
  if (JSON.stringify(Object.keys(review.checks ?? {}).sort()) !== JSON.stringify(Object.keys(expected.checks).sort())
    || !Object.keys(expected.checks).every(key => review.checks[key] === true)) throw Error('CLAWBOT_GENERATION_REVIEW_UNCONFIRMED');
}
