import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATION_ROLES, migrationPath, validateMigrationManifest } from './migration-format.mjs';
import { fileSha256, verifyMigrationFiles } from './migration-files.mjs';
import { verifyMigrationSemantics } from './migration-semantics.mjs';
import { databaseAudit } from './database-audit.mjs';

// Operates only on a previously mapped, offline package. It does not guess
// live Windows locations, stop services or manufacture a stop attestation.
export async function buildMigrationManifest(directory, { source, target }, { rehearsal = false } = {}) {
  const payload = join(directory, 'payload');
  if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) throw new Error('CLAWBOT_PACKAGE_DIRECTORY');
  const entries = []; let bytes = 0;
  async function inventory(relative) {
    migrationPath(relative);
    const path = join(payload, relative), stat = lstatSync(path);
    if (entries.length >= 100000 || stat.isSymbolicLink()) throw new Error('CLAWBOT_PACKAGE_FILE');
    if (stat.isDirectory()) {
      entries.push({ path: relative, type: 'directory' });
      for (const name of readdirSync(path).sort()) await inventory(`${relative}/${name}`);
    } else {
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 2 ** 30) throw new Error('CLAWBOT_PACKAGE_FILE');
      bytes += stat.size; if (bytes > 40 * 2 ** 30) throw new Error('CLAWBOT_PACKAGE_BUDGET');
      entries.push({ path: relative, type: 'file', bytes: stat.size, sha256: await fileSha256(path) });
    }
  }
  for (const role of MIGRATION_ROLES) await inventory(role);
  const manifest = { format: 'clawbot-migration-directory-v1', source, target, entries, databases: {} };
  for (const [name, path] of [['ledger', 'ledger-data/data/ezbookkeeping.db'], ['receipts', 'receipts/message-receipts.sqlite']]) {
    manifest.databases[name] = { path, auditSha256: databaseAudit(join(payload, path)).auditSha256 };
  }
  validateMigrationManifest(manifest, { rehearsal, expectedSourceSha256: source?.snapshotSha256, expectedTargetCommit: target?.sourceCommit });
  await verifyMigrationFiles(payload, manifest); verifyMigrationSemantics(payload, manifest);
  return manifest;
}
