import test from 'node:test';
import assert from 'node:assert/strict';
import { generationSwitchTemplate, releaseUpdateSwitchTemplate, switchReleaseUpdateInMaintenance } from '../../../scripts/mac/generation-switch.mjs';
import { validateReleaseUpdateSelection } from '../../../scripts/mac/release-update-review.mjs';
const before = { project: 'clawbot-production', sourceCommit: 'a'.repeat(40), sourceSnapshotSha256: 'b'.repeat(64),
  cutoverId: '11111111-2222-3333-4444-555555555555', importManifestSha256: 'c'.repeat(64), volumeGeneration: null,
  services: { origin: { image: 'pinned-origin' }, openclaw: { image: `sha256:${'d'.repeat(64)}` }, guard: { image: `sha256:${'e'.repeat(64)}` } } };
const after = { ...before, sourceCommit: 'f'.repeat(40), volumeGeneration: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', recoverySourceManifestSha256: '1'.repeat(64),
  services: { origin: before.services.origin, openclaw: { image: `sha256:${'2'.repeat(64)}` }, guard: { image: `sha256:${'3'.repeat(64)}` } } };
function fixture() {
  const events = [], evidence = { currentBackupManifestSha256: '1'.repeat(64), currentAuditSha256: '4'.repeat(64), selectedAuditSha256: '5'.repeat(64) };
  const review = releaseUpdateSwitchTemplate(before, after, evidence);
  review.reviewedAt = new Date().toISOString(); for (const key of Object.keys(review.checks)) review.checks[key] = true;
  const driver = name => ({ inspect: async () => ({ available: true, identityValid: true, namespaceValid: true, running: { origin: false, openclaw: false, guard: false } }),
    validateInputs: async () => true, storage: async () => ({ hostFreeBytes: 20 * 2 ** 30, volumeFreeBytes: 8 * 2 ** 30 }),
    retireStopped: async () => events.push(`${name}:retire`), createStopped: async () => events.push(`${name}:create`) });
  return { events, options: { before, after, evidence, review, oldDriver: driver('old'), newDriver: driver('new'),
    verifyData: async () => events.push('audit'), stopHost: async s => events.push(`stop:${s === before ? 'old' : 'new'}`),
    selectHost: async s => events.push(`select:${s === before ? 'old' : 'new'}`), startHost: async s => events.push(`start:${s === before ? 'old' : 'new'}`), checkpoint: async () => {} } };
}
test('only explicit release review permits new images and both releases stay in maintenance', async () => {
  assert.throws(() => generationSwitchTemplate(before, after, {}));
  const f = fixture(); const result = await switchReleaseUpdateInMaintenance(f.options);
  assert.equal(result.status, 'CLAWBOT_RELEASE_UPDATE_SELECTED_IN_MAINTENANCE'); assert.equal(result.businessStarted, false);
  assert.deepEqual(f.events, ['audit', 'stop:old', 'audit', 'old:retire', 'new:create', 'audit', 'select:new', 'start:new']);
  const denied = fixture(); denied.options.review.checks.exactReleaseCompatibilityVerified = false;
  await assert.rejects(switchReleaseUpdateInMaintenance(denied.options)); assert.deepEqual(denied.events, []);
});
test('new release host load failure restores old containers and source selection without business start', async () => {
  const f = fixture(); f.options.startHost = async s => { f.events.push(`start:${s === before ? 'old' : 'new'}`); if (s === after) throw Error('load'); };
  const result = await switchReleaseUpdateInMaintenance(f.options);
  assert.equal(result.status, 'CLAWBOT_RELEASE_UPDATE_SWITCH_ROLLED_BACK_IN_MAINTENANCE');
  assert.deepEqual(f.events.slice(-6), ['audit', 'stop:new', 'new:retire', 'old:create', 'select:old', 'start:old']);
});
test('changed data after host stop prevents automatic old-release rollback', async () => {
  const f = fixture(); let audits = 0;
  f.options.verifyData = async () => { if (++audits > 1) throw Error('changed'); };
  await assert.rejects(switchReleaseUpdateInMaintenance(f.options), /REQUIRES_INSPECTION/);
  assert.deepEqual(f.events, ['stop:old']);
});
test('release selection refuses historical backup, wrong images and database changes', () => {
  const manifest = { audit: { inventorySha256: 'same-source', databases: { ledger: 'ledger-audit', receipts: 'receipt-audit' } } };
  const stage = { status: 'CLAWBOT_RELEASE_UPDATE_GENERATION_STAGED', productionActivated: false, productionInputsVerified: true,
    filesPreservedExceptSourceBindings: true, previousSourceCommit: before.sourceCommit, previousRuntimeImage: before.services.openclaw.image,
    runtimeImage: after.services.openclaw.image, guardImage: after.services.guard.image, recoverySourceManifestSha256: after.recoverySourceManifestSha256,
    sourceAudit: manifest.audit, stagedAudit: { inventorySha256: 'new-bindings', databases: manifest.audit.databases } };
  validateReleaseUpdateSelection(stage, before, after, manifest, '1'.repeat(64));
  assert.throws(() => validateReleaseUpdateSelection(stage, before, after, manifest, '9'.repeat(64)), /current backup/);
  assert.throws(() => validateReleaseUpdateSelection({ ...stage, runtimeImage: before.services.openclaw.image }, before, after, manifest, '1'.repeat(64)));
  assert.throws(() => validateReleaseUpdateSelection({ ...stage, stagedAudit: { databases: { ledger: 'changed', receipts: 'receipt-audit' } } }, before, after, manifest, '1'.repeat(64)), /cannot transform/);
});
