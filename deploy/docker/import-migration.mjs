import { readFileSync, writeFileSync, lstatSync, readdirSync, mkdirSync, copyFileSync, chmodSync, chownSync, constants } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateMigrationManifest, MIGRATION_ROLES, migrationFileMode } from './migration-format.mjs';
import { verifyMigrationFiles } from './migration-files.mjs';
import { databaseAudit } from './database-audit.mjs';
import { verifyMigrationSemantics } from './migration-semantics.mjs';
import { verifyImportReceipts } from './import-receipts.mjs';
const [mode, project, expectedSourceSha256, expectedTargetCommit] = process.argv.slice(2);
let stage = 'manifest';
try {
  const rehearsal = mode === 'rehearsal';
  if (!(rehearsal ? /^clawbot-import-check-[a-f0-9]{12}$/.test(project) : mode === 'production' && project === 'clawbot-production')) throw new Error('Destination policy');
  const manifestFile = '/package/manifest.json';
  if (lstatSync(manifestFile).size > 16 * 1024 * 1024 || lstatSync(manifestFile).isSymbolicLink()) throw new Error('Manifest file');
  const manifestText = readFileSync(manifestFile), manifest = JSON.parse(manifestText);
  validateMigrationManifest(manifest, { rehearsal, expectedSourceSha256, expectedTargetCommit });
  stage = 'source-files'; await verifyMigrationFiles('/package/payload', manifest);
  stage = 'source-semantics'; verifyMigrationSemantics('/package/payload', manifest);
  stage = 'source-databases';
  for (const db of Object.values(manifest.databases)) {
    if (databaseAudit(join('/package/payload', db.path)).auditSha256 !== db.auditSha256) throw new Error('Source database audit');
  }
  stage = 'empty-destinations';
  for (const role of MIGRATION_ROLES) {
    const path = join('/target', role);
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || readdirSync(path).length) throw new Error('Refusing nonempty destination');
  }
  stage = 'copy';
  const entries = [...manifest.entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  for (const entry of entries) {
    const path = join('/target', entry.path);
    if (entry.type === 'directory') {
      mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); chownSync(path, 1000, 1000);
    } else {
      // Exclusive copy only; a partial prior import is never overwritten.
      copyFileSync(join('/package/payload', entry.path), path, constants.COPYFILE_EXCL);
      chmodSync(path, migrationFileMode(entry.path)); chownSync(path, 1000, 1000);
    }
  }
  stage = 'target-files'; await verifyMigrationFiles('/target', manifest, { target: true });
  stage = 'target-databases';
  const tables = {};
  for (const [kind, db] of Object.entries(manifest.databases)) {
    const audit = databaseAudit(join('/target', db.path));
    if (audit.auditSha256 !== db.auditSha256) throw new Error('Target database audit');
    tables[kind] = audit.tableCount;
  }
  stage = 'receipt';
  const receipt = { version: 1, project, sourceSnapshotSha256: expectedSourceSha256, sourceCommit: expectedTargetCommit,
    cutoverId: manifest.target.cutoverId, manifestSha256: createHash('sha256').update(manifestText).digest('hex'),
    checkedAt: new Date().toISOString(), fileInventory: true, databaseAudits: true, activated: false };
  for (const role of MIGRATION_ROLES) {
    const path = join('/target', role, '.clawbot-import.json');
    writeFileSync(path, JSON.stringify(receipt), { flag: 'wx', mode: 0o400 }); chownSync(path, 1000, 1000);
  }
  verifyImportReceipts('/target', { project, cutoverId: receipt.cutoverId, sourceSnapshotSha256: expectedSourceSha256,
    importManifestSha256: receipt.manifestSha256 });
  console.log(JSON.stringify({ status: 'CLAWBOT_MIGRATION_NEW_VOLUMES_VERIFIED', volumes: 9, entries: entries.length, tables,
    importManifestSha256: receipt.manifestSha256, activated: false }));
} catch { console.error(`CLAWBOT_MIGRATION_IMPORT_FAILED:${stage}`); process.exit(1); }
