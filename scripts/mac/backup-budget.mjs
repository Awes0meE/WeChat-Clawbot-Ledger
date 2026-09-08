export const BACKUP_BUDGET = Object.freeze({ reserveBytes: 10 * 2 ** 30, archiveBudgetBytes: 20 * 2 ** 30 });
export function assertBackupBudget({ freeBytes, existingBytes, sourceBytes, entries }, budget = BACKUP_BUDGET) {
  for (const n of [freeBytes, existingBytes, sourceBytes, entries]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('CLAWBOT_BACKUP_SIZE_UNKNOWN');
  }
  // tar headers, padding and inventory; allow two copies for archive + offline
  // restore in Docker's sparse disk, retaining host reserve throughout.
  const estimatedArchiveBytes = sourceBytes + entries * 4096 + 16 * 2 ** 20;
  if (existingBytes + estimatedArchiveBytes > budget.archiveBudgetBytes) throw new Error('CLAWBOT_BACKUP_BUDGET_FULL');
  if (freeBytes < budget.reserveBytes + estimatedArchiveBytes * 2) throw new Error('CLAWBOT_BACKUP_DISK_RESERVE');
  return estimatedArchiveBytes;
}
