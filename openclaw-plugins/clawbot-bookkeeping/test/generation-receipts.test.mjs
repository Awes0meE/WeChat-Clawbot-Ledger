import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generationReceipt, verifyGenerationReceipts } from '../../../deploy/docker/generation-receipts.mjs';
import { MIGRATION_ROLES } from '../../../deploy/docker/migration-format.mjs';

test('all nine generation receipts bind the exact selected archive and reject partial or changed state', { skip: process.platform === 'win32' }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-generation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const spec = { project: 'clawbot-production', volumeGeneration: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    sourceCommit: 'a'.repeat(40), cutoverId: '11111111-2222-3333-4444-555555555555', importManifestSha256: 'b'.repeat(64),
    recoverySourceManifestSha256: 'c'.repeat(64) };
  const bytes = JSON.stringify(generationReceipt(spec));
  const paths = MIGRATION_ROLES.map(role => { mkdirSync(join(directory, role)); return join(directory, role, 'recovery-generation.json'); });
  for (const path of paths.slice(0, -1)) writeFileSync(path, bytes, { mode: 0o400 });
  assert.throws(() => verifyGenerationReceipts(directory, spec));
  writeFileSync(paths.at(-1), bytes, { mode: 0o400 }); assert.ok(verifyGenerationReceipts(directory, spec));
  assert.throws(() => verifyGenerationReceipts(directory, { ...spec, recoverySourceManifestSha256: 'd'.repeat(64) }));
  chmodSync(paths[0], 0o600); assert.throws(() => verifyGenerationReceipts(directory, spec));
  rmSync(paths[0]); symlinkSync(paths[1], paths[0]); assert.throws(() => verifyGenerationReceipts(directory, spec));
});
