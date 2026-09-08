import assert from 'node:assert/strict';

// Shared maintenance operation. The host authenticates the backup, validates
// its release/job/volume identities and takes the exclusive lock beforehand.
// No start, restart, gate clearing or database restore capability is accepted.
export async function applyLedgerTokenUpdate({ action, evidence, manifest, reviewBytes, loadReview,
  loadStarted, saveStarted, quiescent, fullAudit, helper, saveReceipt, now = Date.now() }) {
  assert.ok(['apply', 'resume'].includes(action));
  const review = JSON.parse(reviewBytes);
  for (const [key, value] of Object.entries(evidence)) assert.deepEqual(review[key], value);
  assert.match(review.binding, /^[a-f0-9]{64}$/);
  const age = now - Date.parse(review.reviewedAt);
  assert.ok(review.approved === true && age >= 0 && age <= 30 * 60000);
  const operation = { ...evidence, binding: review.binding };
  assert.deepEqual(await quiescent(), evidence.unrelatedAudit);
  if (action === 'apply') {
    assert.deepEqual(await fullAudit(), manifest.audit);
    const inspection = await helper('inspect');
    assert.equal(inspection.status, 'CLAWBOT_LEDGER_ROTATION_READY_FOR_REVIEW');
    assert.equal(inspection.binding, review.binding);
    await saveStarted(operation);
  } else assert.deepEqual(await loadStarted(review.binding), operation);
  assert.deepEqual(await loadReview(), reviewBytes);
  assert.deepEqual(await quiescent(), evidence.unrelatedAudit);
  const result = await helper(action, review.binding);
  const alreadySaved = action === 'resume' && result.status === 'CLAWBOT_LEDGER_SAVED_PAIR_VERIFIED' && result.readOnlySavedPair === true;
  if (!alreadySaved) {
    assert.equal(result.status, 'CLAWBOT_LEDGER_TOKENS_SAVED_MAINTENANCE_REQUIRED');
    assert.equal(result.binding, review.binding); assert.equal(result.unrelatedStatePreserved, true);
  }
  assert.deepEqual(await quiescent(), evidence.unrelatedAudit);
  const afterAudit = await fullAudit(); assert.deepEqual(afterAudit.databases, manifest.audit.databases);
  const record = { ...operation, status: result.status, afterAudit, expiresAt: result.expiresAt,
    observedAt: new Date().toISOString(), remoteVerified: false, maintenanceRequired: true };
  const receipt = await saveReceipt(record);
  return { status: result.status, receipt, remoteVerified: false, maintenanceRequired: true };
}
