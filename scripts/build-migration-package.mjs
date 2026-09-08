import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildMigrationManifest } from '../deploy/docker/build-migration-manifest.mjs';

// The private receipt is an operator attestation, not a substitute for actually
// verifying Windows is stopped. It must be produced from the final backup.
try {
  const [directoryArg, receiptArg, option] = process.argv.slice(2), rehearsal = option === '--synthetic';
  if (!directoryArg || !receiptArg || (option && !rehearsal) || (!rehearsal && process.platform !== 'win32')) throw new Error();
  const directory = realpathSync(resolve(directoryArg)), receiptPath = realpathSync(resolve(receiptArg));
  const repository = fileURLToPath(new URL('../', import.meta.url));
  for (const path of [directory, receiptPath]) {
    const local = relative(repository, path);
    if (local === '' || (!local.startsWith('..') && !isAbsolute(local))) throw new Error();
  }
  const stat = lstatSync(receiptPath), directoryStat = lstatSync(directory);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || !directoryStat.isDirectory()) throw new Error();
  if (process.platform !== 'win32' && ((stat.mode & 0o077) || (directoryStat.mode & 0o077))) throw new Error();
  // On Windows the handoff checks owner-only ACLs; POSIX mode bits do not
  // establish Windows ACL privacy. Do not silently rewrite a user's ACL here.
  const receipt = JSON.parse(readFileSync(receiptPath));
  const manifest = await buildMigrationManifest(directory, receipt, { rehearsal });
  const encoded = JSON.stringify(manifest);
  writeFileSync(join(directory, 'manifest.json'), encoded, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'CLAWBOT_OFFLINE_MIGRATION_PACKAGE_VERIFIED', entries: manifest.entries.length,
    manifestSha256: createHash('sha256').update(encoded).digest('hex'), sourcePlatform: manifest.source.platform }));
} catch { console.error('CLAWBOT_MIGRATION_PACKAGE_BUILD_REFUSED'); process.exitCode = 1; }
