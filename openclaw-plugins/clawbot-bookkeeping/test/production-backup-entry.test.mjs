import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedRuntimeSpec } from '../../../scripts/mac/managed-runtime-spec.mjs';
import { backupProductionState } from '../../../scripts/mac/backup-production-state.mjs';

test('production entry forwards the actual managed image and enforces maintenance before backup', { skip: process.platform === 'win32' }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-backup-entry-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const image = `sha256:${'a'.repeat(64)}`;
  const spec = managedRuntimeSpec({ profile: 'production', project: 'clawbot-production', runtimeImage: image,
    guardImage: `sha256:${'b'.repeat(64)}`, sourceCommit: 'c'.repeat(40), cutoverId: '12345678-1234-1234-1234-123456789abc',
    sourceSnapshotSha256: 'd'.repeat(64), importManifestSha256: 'e'.repeat(64) });
  const marker = join(directory, 'production-maintenance');
  writeFileSync(marker, JSON.stringify({ project: spec.project, sourceCommit: spec.sourceCommit, cutoverId: spec.cutoverId,
    importManifestSha256: spec.importManifestSha256 }), { mode: 0o600 });
  let running = false, captured = 0, expectedGeneration = null;
  const driver = { inspect: async () => ({ available: true, identityValid: true, running: { origin: running, openclaw: false, guard: false } }),
    validateInputs: async () => true };
  const backup = async options => {
    assert.equal(options.image, image); assert.equal(options.project, 'clawbot-production'); assert.equal(options.volumeGeneration, expectedGeneration);
    await options.assertQuiescent(); captured++; return { status: 'synthetic-backup-accepted' };
  };
  assert.equal((await backupProductionState({ spec, driver, base: directory, operations: directory, backup })).status, 'synthetic-backup-accepted');
  running = true;
  await assert.rejects(backupProductionState({ spec, driver, base: directory, operations: directory, backup }));
  running = false; writeFileSync(marker, '{}');
  await assert.rejects(backupProductionState({ spec, driver, base: directory, operations: directory, backup }));
  assert.equal(captured, 1);
  expectedGeneration = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const generationSpec = managedRuntimeSpec({ profile: 'production', project: spec.project, runtimeImage: image,
    guardImage: spec.services.guard.image, sourceCommit: spec.sourceCommit, cutoverId: spec.cutoverId,
    sourceSnapshotSha256: spec.sourceSnapshotSha256, importManifestSha256: spec.importManifestSha256,
    volumeGeneration: expectedGeneration, recoverySourceManifestSha256: 'f'.repeat(64) });
  writeFileSync(marker, JSON.stringify({ project: spec.project, sourceCommit: spec.sourceCommit, cutoverId: spec.cutoverId,
    importManifestSha256: spec.importManifestSha256, volumeGeneration: expectedGeneration }));
  await backupProductionState({ spec: generationSpec, driver, base: directory, operations: directory, backup });
  assert.equal(captured, 2);
});
