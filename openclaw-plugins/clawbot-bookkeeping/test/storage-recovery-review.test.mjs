import test from 'node:test';
import assert from 'node:assert/strict';
import { storageRecoveryTemplate, validateStorageRecoveryReview, clearReviewedStorageFault } from '../../../scripts/mac/storage-recovery-review.mjs';
import { archiveReviewedStorageFault } from '../../../scripts/mac/archive-storage-fault.mjs';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const spec = { project: 'clawbot-production', sourceCommit: 'a'.repeat(40), cutoverId: 'synthetic', importManifestSha256: 'b'.repeat(64) };
const evidence = { faultSha256: 'c'.repeat(64), backupManifestSha256: 'd'.repeat(64), dataAuditSha256: 'e'.repeat(64) };
const confirmed = () => { const r = storageRecoveryTemplate(spec, evidence); r.reviewedAt = new Date().toISOString();
  for (const key of Object.keys(r.checks)) r.checks[key] = true; return r; };
function context() {
  const actions = [], driver = {
    inspect: async () => ({ available: true, identityValid: true, namespaceValid: true, running: { origin: false, openclaw: false, guard: false } }),
    validateInputs: async () => true,
    storage: async () => ({ hostFreeBytes: 20 * 2 ** 30, volumeFreeBytes: 8 * 2 ** 30 }),
  };
  return { actions, options: { driver, spec, evidence, review: confirmed(),
    verifyEvidence: async () => { actions.push('audit'); }, stopHost: async () => { actions.push('stop-host'); },
    archiveAndClear: async () => { actions.push('archive-clear'); }, restartHost: async () => { actions.push('restart-host-in-maintenance'); } } };
}
test('recovery review rejects unconfirmed, stale, future, missing checks and changed fault/data bindings', () => {
  assert.throws(() => validateStorageRecoveryReview(storageRecoveryTemplate(spec, evidence), spec, evidence));
  for (const patch of [{ reviewedAt: new Date(Date.now() - 31 * 60000).toISOString() },
    { reviewedAt: new Date(Date.now() + 60000).toISOString() }, { checks: {} }, { faultSha256: 'f'.repeat(64) },
    { dataAuditSha256: 'f'.repeat(64) }, { sourceCommit: 'f'.repeat(40) }]) {
    assert.throws(() => validateStorageRecoveryReview({ ...confirmed(), ...patch }, spec, evidence));
  }
});
test('confirmed release rechecks data after stopping host and preserves separate maintenance restart', async () => {
  const c = context(); await clearReviewedStorageFault(c.options);
  assert.deepEqual(c.actions, ['audit', 'stop-host', 'audit', 'archive-clear', 'restart-host-in-maintenance']);
});
test('live consumers, low reserve, bad inputs and missing review cannot stop host or clear fault', async () => {
  for (const failure of ['running', 'space', 'inputs', 'review']) {
    const c = context();
    if (failure === 'running') c.options.driver.inspect = async () => ({ available: true, identityValid: true, namespaceValid: true, running: { origin: true } });
    if (failure === 'space') c.options.driver.storage = async () => ({ hostFreeBytes: 6 * 2 ** 30, volumeFreeBytes: 8 * 2 ** 30 });
    if (failure === 'inputs') c.options.driver.validateInputs = async () => false;
    if (failure === 'review') c.options.review.checks.unresolvedClaimsPreserved = false;
    await assert.rejects(clearReviewedStorageFault(c.options)); assert.deepEqual(c.actions, []);
  }
});
test('changed data after stop preserves fault; failed host restart never rolls databases back', async () => {
  const c = context(); let n = 0;
  c.options.verifyEvidence = async () => { c.actions.push('audit'); if (++n === 2) throw Error('changed'); };
  await assert.rejects(clearReviewedStorageFault(c.options), /changed/);
  assert.deepEqual(c.actions, ['audit', 'stop-host', 'audit']);
  const d = context(); d.options.restartHost = async () => { throw Error('host-start-failed'); };
  await assert.rejects(clearReviewedStorageFault(d.options), /host-start-failed/);
  assert.deepEqual(d.actions, ['audit', 'stop-host', 'audit', 'archive-clear']);
});
test('private archive is durable before removal and rejects changed faults or existing archives', { skip: process.platform === 'win32' }, (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-fault-archive-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const faultPath = join(directory, 'fault.json'), archivePath = join(directory, 'archive.json');
  const faultBytes = Buffer.from('{"version":1,"synthetic":true}'), reviewBytes = Buffer.from(JSON.stringify(confirmed()));
  writeFileSync(faultPath, faultBytes, { mode: 0o600 });
  assert.throws(() => archiveReviewedStorageFault({ faultPath, archivePath, faultBytes: Buffer.from('{}'), reviewBytes }));
  assert.ok(existsSync(faultPath)); assert.equal(existsSync(archivePath), false);
  archiveReviewedStorageFault({ faultPath, archivePath, faultBytes, reviewBytes });
  assert.equal(existsSync(faultPath), false);
  assert.deepEqual(JSON.parse(readFileSync(archivePath)).fault, JSON.parse(faultBytes));
  writeFileSync(faultPath, faultBytes, { mode: 0o600 });
  assert.throws(() => archiveReviewedStorageFault({ faultPath, archivePath, faultBytes, reviewBytes }));
  assert.deepEqual(readFileSync(faultPath), faultBytes);
});
