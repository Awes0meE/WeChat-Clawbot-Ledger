import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { restoreNineBackup } from './restore-nine-backup.mjs';
import { waitForOperationLock, operationsRoot } from './operation-lock.mjs';
const [directoryArg, keyArg, image, option] = process.argv.slice(2);
if (!directoryArg || !keyArg || !image || (option && option !== '--retain')) throw new Error('Usage: verify-nine-backup.mjs <backup-directory> <private-key-file> <image-sha256> [--retain]');
const directory = resolve(directoryArg), keyPath = resolve(keyArg), base = join(homedir(), 'Library', 'Application Support', 'Clawbot');
assert.ok(directory.startsWith(join(base, 'production-backups') + '/') && keyPath.startsWith(join(base, 'production-backup-keys') + '/'));
const unlock = await waitForOperationLock('historical-backup-recovery');
try {
  const result = await restoreNineBackup({ directory, keyPath, image, retain: option === '--retain' });
  const records = join(operationsRoot, 'recovery-checks'); mkdirSync(records, { recursive: true, mode: 0o700 });
  writeFileSync(join(records, `${result.project}.json`), JSON.stringify({ ...result, checkedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(result));
} catch { console.error('CLAWBOT_HISTORICAL_BACKUP_RECOVERY_FAILED'); process.exitCode = 1; }
finally { unlock(); }
