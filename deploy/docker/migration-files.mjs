import { lstatSync, readdirSync, realpathSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MIGRATION_ROLES, migrationPath, migrationFileMode } from './migration-format.mjs';
export async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function verifyMigrationFiles(root, manifest, { target = false } = {}) {
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('CLAWBOT_MIGRATION_ROOT');
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  let count = 0;
  async function walk(relative) {
    migrationPath(relative);
    const entry = expected.get(relative), path = join(root, relative), stat = lstatSync(path);
    if (!entry || stat.isSymbolicLink() || (target && (stat.uid !== 1000 || stat.gid !== 1000))) throw new Error('CLAWBOT_MIGRATION_FILE_TYPE');
    if (entry.type === 'directory') {
      if (!stat.isDirectory() || (target && (stat.mode & 0o777) !== 0o700)) throw new Error('CLAWBOT_MIGRATION_DIRECTORY');
      for (const name of readdirSync(path)) await walk(`${relative}/${name}`);
    } else {
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.bytes
        || (target && (stat.mode & 0o777) !== migrationFileMode(relative))) throw new Error('CLAWBOT_MIGRATION_FILE');
      if (await fileSha256(path) !== entry.sha256) throw new Error('CLAWBOT_MIGRATION_FILE_HASH');
    }
    count++;
  }
  if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify([...MIGRATION_ROLES].sort())) throw new Error('CLAWBOT_MIGRATION_VOLUME_SET');
  for (const role of MIGRATION_ROLES) await walk(role);
  if (count !== manifest.entries.length) throw new Error('CLAWBOT_MIGRATION_MISSING_FILE');
  return count;
}
