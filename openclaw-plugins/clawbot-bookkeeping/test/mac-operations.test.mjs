import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireOperationLock } from '../../../scripts/mac/operation-lock.mjs';
import { assertBackupBudget } from '../../../scripts/mac/backup-budget.mjs';

test('Mac operations exclude concurrent work and refuse to release a changed owner', { skip: process.platform === 'win32' }, () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-lock-')));
  try {
    const release = acquireOperationLock('backup', { directory });
    assert.throws(() => acquireOperationLock('recovery', { directory }), /OPERATION_BUSY/);
    release(); release();
    const release2 = acquireOperationLock('recovery', { directory });
    writeFileSync(join(directory, 'clawbot-test.lock', 'owner.json'), '{}');
    assert.throws(release2, /OWNER_CHANGED/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Backup budget reserves host space for archive and restore and never treats unknown sizes as zero', () => {
  const input = { freeBytes: 100 * 2 ** 30, existingBytes: 0, sourceBytes: 2 ** 30, entries: 100 };
  assert.ok(assertBackupBudget(input) > input.sourceBytes);
  assert.throws(() => assertBackupBudget({ ...input, freeBytes: 11 * 2 ** 30 }), /DISK_RESERVE/);
  assert.throws(() => assertBackupBudget({ ...input, existingBytes: 20 * 2 ** 30 }), /BUDGET_FULL/);
  assert.throws(() => assertBackupBudget({ ...input, sourceBytes: undefined }), /SIZE_UNKNOWN/);
});
