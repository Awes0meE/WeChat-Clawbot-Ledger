import test from 'node:test';
import assert from 'node:assert/strict';
import { generationSwitchTemplate, switchGenerationInMaintenance } from '../../../scripts/mac/generation-switch.mjs';
const before = { project: 'clawbot-production', sourceCommit: 'a'.repeat(40), cutoverId: 'synthetic', sourceSnapshotSha256: 'b'.repeat(64),
  importManifestSha256: 'c'.repeat(64), volumeGeneration: null, services: Object.fromEntries(['origin', 'openclaw', 'guard'].map(role => [role, { image: `sha256:${'d'.repeat(64)}` }])) };
const after = { ...before, volumeGeneration: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', recoverySourceManifestSha256: 'e'.repeat(64) };
function fixture() {
  const events = [], evidence = { currentAuditSha256: 'f'.repeat(64) }, review = generationSwitchTemplate(before, after, evidence);
  review.reviewedAt = new Date().toISOString(); for (const key of Object.keys(review.checks)) review.checks[key] = true;
  const driver = name => ({ inspect: async () => ({ available: true, identityValid: true, namespaceValid: true, running: { origin: false, openclaw: false, guard: false } }),
    validateInputs: async () => true, storage: async () => ({ hostFreeBytes: 20 * 2 ** 30, volumeFreeBytes: 8 * 2 ** 30 }),
    retireStopped: async () => events.push(`${name}:retire`), createStopped: async () => events.push(`${name}:create`) });
  return { events, options: { before, after, oldDriver: driver('old'), newDriver: driver('new'), review, evidence,
    verifyData: async () => events.push('audit'), stopHost: async s => events.push(`stop:${s === before ? 'old' : 'new'}`),
    selectHost: async s => events.push(`select:${s === before ? 'old' : 'new'}`), startHost: async s => events.push(`start:${s === before ? 'old' : 'new'}`), checkpoint: async () => {} } };
}
test('generation switch never starts business services and separates image upgrades', async () => {
  const f = fixture(), result = await switchGenerationInMaintenance(f.options);
  assert.equal(result.status, 'CLAWBOT_GENERATION_SELECTED_IN_MAINTENANCE'); assert.equal(result.businessStarted, false);
  assert.deepEqual(f.events, ['audit', 'stop:old', 'audit', 'old:retire', 'new:create', 'audit', 'select:new', 'start:new']);
  assert.throws(() => generationSwitchTemplate(before, { ...after, services: { ...after.services, guard: { image: 'other' } } }, {}));
});
test('failed target preparation restores stopped old containers and host when data is unchanged', async () => {
  const f = fixture(); f.options.newDriver.createStopped = async () => { throw Error('create failed'); };
  const result = await switchGenerationInMaintenance(f.options);
  assert.equal(result.status, 'CLAWBOT_GENERATION_SWITCH_ROLLED_BACK_IN_MAINTENANCE');
  assert.ok(f.events.includes('new:retire')); assert.ok(f.events.includes('old:create'));
  assert.deepEqual(f.events.slice(-2), ['select:old', 'start:old']);
});
test('unreviewed requests cannot mutate anything and data changes prevent automatic rollback', async () => {
  const f = fixture(); f.options.review.checks.allOldVolumesRetained = false;
  await assert.rejects(switchGenerationInMaintenance(f.options)); assert.deepEqual(f.events, []);
  const changed = fixture(); let audits = 0;
  changed.options.verifyData = async () => { if (++audits > 1) throw Error('changed'); };
  await assert.rejects(switchGenerationInMaintenance(changed.options), /REQUIRES_INSPECTION/);
  assert.deepEqual(changed.events, ['stop:old']);
});
