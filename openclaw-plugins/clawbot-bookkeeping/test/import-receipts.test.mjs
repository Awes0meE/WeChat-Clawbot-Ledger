import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATION_ROLES } from '../../../deploy/docker/migration-format.mjs';
import { verifyImportReceipts } from '../../../deploy/docker/import-receipts.mjs';
test('Production refuses partial or mixed imports even when all nine named volumes exist', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'clawbot-import-proof-'));
  const expected = { project: 'clawbot-production', cutoverId: '11111111-2222-3333-4444-555555555555', sourceSnapshotSha256: 'a'.repeat(64), importManifestSha256: 'b'.repeat(64) };
  const receipt = { version: 1, ...expected, manifestSha256: expected.importManifestSha256, sourceCommit: 'c'.repeat(40),
    fileInventory: true, databaseAudits: true, activated: false, checkedAt: '2026-09-08T00:00:00Z' };
  try {
    for (const role of MIGRATION_ROLES) { mkdirSync(join(root, role)); writeFileSync(join(root, role, '.clawbot-import.json'), JSON.stringify(receipt), { mode: 0o400 }); }
    assert.equal(verifyImportReceipts(root, expected), true);
    const path = join(root, 'receipts', '.clawbot-import.json'); unlinkSync(path);
    assert.throws(() => verifyImportReceipts(root, expected));
    writeFileSync(path, JSON.stringify({ ...receipt, manifestSha256: 'd'.repeat(64) }), { mode: 0o400 });
    assert.throws(() => verifyImportReceipts(root, expected), /RECEIPT_MISMATCH/);
    chmodSync(path, 0o600); assert.throws(() => verifyImportReceipts(root, expected), /RECEIPT_FILE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
