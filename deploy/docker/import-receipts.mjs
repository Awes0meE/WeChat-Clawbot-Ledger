import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATION_ROLES } from './migration-format.mjs';
export function verifyImportReceipts(root, { project, cutoverId, sourceSnapshotSha256, importManifestSha256 }) {
  let first;
  for (const role of MIGRATION_ROLES) {
    const path = join(root, role, '.clawbot-import.json'), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (stat.mode & 0o222)) throw new Error('CLAWBOT_IMPORT_RECEIPT_FILE');
    const encoded = readFileSync(path, 'utf8'), value = JSON.parse(encoded);
    if (value.version !== 1 || value.project !== project || value.cutoverId !== cutoverId
      || value.sourceSnapshotSha256 !== sourceSnapshotSha256 || value.manifestSha256 !== importManifestSha256
      || value.fileInventory !== true || value.databaseAudits !== true || value.activated !== false
      || !/^[a-f0-9]{40}$/.test(value.sourceCommit ?? '') || !Number.isFinite(Date.parse(value.checkedAt ?? ''))
      || (first !== undefined && encoded !== first)) throw new Error('CLAWBOT_IMPORT_RECEIPT_MISMATCH');
    first = encoded;
  }
  return true;
}
