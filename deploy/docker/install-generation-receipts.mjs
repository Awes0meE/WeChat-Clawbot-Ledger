import { readFileSync, writeFileSync, lstatSync, existsSync, readdirSync, openSync, closeSync, fsyncSync, renameSync, chownSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { generationReceipt, verifyGenerationReceipts } from './generation-receipts.mjs';
import { MIGRATION_ROLES } from './migration-format.mjs';
try {
  const spec = JSON.parse(process.argv[2]), previous = JSON.parse(process.argv[3]);
  const previousSourceCommit = process.argv[4] ?? spec.sourceCommit;
  if (!/^[a-f0-9]{40}$/.test(previousSourceCommit)) throw Error();
  const bytes = JSON.stringify(generationReceipt(spec));
  for (const role of MIGRATION_ROLES) {
    const path = join('/generation', role, 'recovery-generation.json');
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o222) || stat.size > 4096) throw Error();
      const old = JSON.parse(readFileSync(path));
      if (previous === null || old.version !== 1 || old.project !== spec.project || old.volumeGeneration !== previous
        || old.cutoverId !== spec.cutoverId || old.sourceCommit !== previousSourceCommit || old.importManifestSha256 !== spec.importManifestSha256) throw Error();
    } else if (previous !== null) throw Error();
  }
  let entries = 0;
  function syncTree(path) {
    if (++entries > 100000) throw Error();
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || stat.isSocket()) return;
    if (stat.isDirectory()) for (const name of readdirSync(path)) syncTree(join(path, name));
    else if (!stat.isFile()) throw Error();
    const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  for (const role of MIGRATION_ROLES) syncTree(join('/generation', role));
  for (const role of MIGRATION_ROLES) {
    const directory = join('/generation', role), path = join(directory, 'recovery-generation.json');
    const temporary = join(directory, `.generation-${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o400);
    try { writeFileSync(fd, bytes); chownSync(temporary, 1000, 1000); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  verifyGenerationReceipts('/generation', spec);
  console.log('CLAWBOT_GENERATION_RECEIPTS_INSTALLED');
} catch { console.error('CLAWBOT_GENERATION_RECEIPTS_NOT_COMPLETE'); process.exitCode = 1; }
