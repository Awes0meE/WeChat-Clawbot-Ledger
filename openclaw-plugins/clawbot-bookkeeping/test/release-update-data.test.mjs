import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MIGRATION_ROLES } from '../../../deploy/docker/migration-format.mjs';
import { releaseUpdateContract, rebindReleaseUpdateData, verifyReleaseUpdateData } from '../../../deploy/docker/release-update-data.mjs';
import { releaseUpdateStageTemplate, validateReleaseUpdateStage } from '../../../scripts/mac/release-update-review.mjs';
const before = { project: 'clawbot-import-check-123456abcdef', sourceCommit: 'a'.repeat(40), sourceSnapshotSha256: 'b'.repeat(64),
  cutoverId: '11111111-2222-3333-4444-555555555555', importManifestSha256: 'c'.repeat(64), volumeGeneration: null,
  services: { origin: { image: 'same-pinned-origin' }, openclaw: { image: `sha256:${'d'.repeat(64)}` }, guard: { image: `sha256:${'e'.repeat(64)}` } } };
const after = { ...before, sourceCommit: 'f'.repeat(40), volumeGeneration: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', recoverySourceManifestSha256: '1'.repeat(64),
  services: { origin: before.services.origin, openclaw: { image: `sha256:${'2'.repeat(64)}` }, guard: { image: `sha256:${'3'.repeat(64)}` } } };
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-update-unit-'))), source = join(root, 'source'), target = join(root, 'target');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const role of MIGRATION_ROLES) { mkdirSync(join(source, role), { recursive: true }); writeFileSync(join(source, role, 'unknown-preserved.bin'), Buffer.from([0, 255, 17])); }
  const policy = { version: 1, profile: 'production', root: '/var/lib/clawbot', port: 8888,
    configPath: '/var/lib/clawbot/config/ezbookkeeping.ini', dbPath: '/var/lib/clawbot/ledger/data/ezbookkeeping.db', configSha256: '4'.repeat(64),
    sourceCommit: before.sourceCommit, sourceSnapshotSha256: before.sourceSnapshotSha256 };
  const activation = { version: 1, project: 'clawbot-production', sourceCommit: before.sourceCommit, sourceSnapshotSha256: before.sourceSnapshotSha256,
    cutoverId: before.cutoverId, windowsReceiverStopped: true, windowsTunnelStopped: true, windowsLedgerStopped: true };
  for (const [name, value] of [['policy', policy], ['activation', activation]]) writeFileSync(join(source, 'guard-config', `${name}.json`), JSON.stringify(value), { mode: 0o400 });
  cpSync(source, target, { recursive: true }); return { source, target };
}
test('release staging rebinds only the two source identities and preserves every other file', { skip: process.platform === 'win32' }, t => {
  const { source, target } = fixture(t), original = readFileSync(join(source, 'guard-config/policy.json'));
  rebindReleaseUpdateData(source, target, before, after);
  assert.deepEqual(readFileSync(join(source, 'guard-config/policy.json')), original);
  assert.equal(JSON.parse(readFileSync(join(target, 'guard-config/policy.json'))).sourceCommit, after.sourceCommit);
  assert.ok(verifyReleaseUpdateData(source, target, before, after, { final: false }).persistentFilesPreserved);
  assert.throws(() => verifyReleaseUpdateData(source, target, before, after), /ENOENT/);
  writeFileSync(join(target, 'receipts/unknown-preserved.bin'), 'changed');
  assert.throws(() => verifyReleaseUpdateData(source, target, before, after, { final: false }), /Unexpected release update data change/);
});
test('changed input, writable control file and unrelated version changes fail before rebind', { skip: process.platform === 'win32' }, t => {
  const { source, target } = fixture(t), beforeBytes = readFileSync(join(target, 'guard-config/policy.json'));
  writeFileSync(join(target, 'secrets/unknown-preserved.bin'), 'different');
  assert.throws(() => rebindReleaseUpdateData(source, target, before, after));
  assert.deepEqual(readFileSync(join(target, 'guard-config/policy.json')), beforeBytes);
  assert.throws(() => releaseUpdateContract(before, { ...after, cutoverId: 'other' }));
  assert.throws(() => releaseUpdateContract(before, { ...after, services: { ...after.services, origin: { image: 'other' } } }));
  assert.throws(() => releaseUpdateContract(before, { ...after, sourceCommit: before.sourceCommit }));
  rmSync(target, { recursive: true, force: true }); cpSync(source, target, { recursive: true }); chmodSync(join(source, 'guard-config/policy.json'), 0o600);
  assert.throws(() => rebindReleaseUpdateData(source, target, before, after));
});
test('release update review binds both versions and images, archive, generation and a current explicit review', () => {
  const candidate = { runtimeImage: before.services.openclaw.image, sourceVolumeGeneration: null, project: 'synthetic-candidate', audit: { bytes: 1 } };
  const review = releaseUpdateStageTemplate(before, after, candidate);
  assert.throws(() => validateReleaseUpdateStage(review, before, after, candidate));
  review.reviewedAt = new Date().toISOString(); for (const k of Object.keys(review.checks)) review.checks[k] = true;
  validateReleaseUpdateStage(review, before, after, candidate);
  assert.throws(() => validateReleaseUpdateStage(review, before, after, { ...candidate, audit: { bytes: 2 } }));
  assert.throws(() => validateReleaseUpdateStage({ ...review, newRuntimeImage: before.services.openclaw.image }, before, after, candidate));
});
