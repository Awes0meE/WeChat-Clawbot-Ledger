import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  unlinkSync,
} from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary');

function result(status, headerValid, quickCheck, activeUserCount) {
  process.stdout.write(`${JSON.stringify({
    status,
    headerValid,
    quickCheck,
    activeUserCount,
  })}\n`);
}

function parseArguments(arguments_) {
  if ((arguments_.length !== 2 && arguments_.length !== 4)
    || arguments_[0] !== '--database'
    || !arguments_[1]
    || (arguments_.length === 4 && (arguments_[2] !== '--backup-to' || !arguments_[3]))) {
    return undefined;
  }
  return { databasePath: arguments_[1], backupPath: arguments_[3] };
}

function hasSqliteHeader(path) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    return bytesRead === SQLITE_HEADER.length && header.equals(SQLITE_HEADER);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function inspectDatabase(databasePath) {
  const headerValid = hasSqliteHeader(databasePath);
  if (!headerValid) throw Object.assign(new Error('invalid header'), { headerValid: false });
  const database = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false, timeout: 5_000, defensive: true });
  try {
    database.exec('PRAGMA query_only = ON;');
    const quickCheckRows = database.prepare('PRAGMA quick_check;').all();
    const quickCheckOk = quickCheckRows.length === 1
      && Object.values(quickCheckRows[0]).length === 1
      && Object.values(quickCheckRows[0])[0] === 'ok';
    if (!quickCheckOk) throw new Error('quick check failed');

    const columns = database.prepare("PRAGMA table_info('user');").all();
    const columnNames = new Set(columns.map((column) => column.name));
    if (!columnNames.has('uid') || !columnNames.has('disabled') || !columnNames.has('deleted')) {
      throw new Error('unexpected user table');
    }
    const countRow = database.prepare(
      'SELECT COUNT(*) AS active_user_count FROM "user" WHERE "deleted" = 0 AND "disabled" = 0;',
    ).get();
    const activeUserCount = Number(countRow?.active_user_count);
    if (!Number.isSafeInteger(activeUserCount) || activeUserCount < 0) {
      throw new Error('invalid active user count');
    }

    return { database, activeUserCount };
  } catch (error) {
    database.close();
    throw Object.assign(error, { headerValid: true });
  }
}

const parsed = parseArguments(process.argv.slice(2));
let headerValid = false;
let source;
let backupAttempted = false;

try {
  if (!parsed) throw new Error('invalid arguments');
  source = inspectDatabase(parsed.databasePath);
  headerValid = true;
  if (parsed.backupPath) {
    if (existsSync(parsed.backupPath)) throw new Error('backup target exists');
    backupAttempted = true;
    await backup(source.database, parsed.backupPath);
    const copied = inspectDatabase(parsed.backupPath);
    try {
      if (copied.activeUserCount !== source.activeUserCount) {
        throw new Error('backup user count differs');
      }
    } finally {
      copied.database.close();
    }
  }
  result('verified', true, 'ok', source.activeUserCount);
} catch (error) {
  if (error?.headerValid === true) headerValid = true;
  result('rejected', headerValid, 'failed', null);
  if (backupAttempted && parsed?.backupPath && existsSync(parsed.backupPath)) {
    try { unlinkSync(parsed.backupPath); } catch { /* a failed cleanup remains a rejected backup */ }
  }
  process.exitCode = 2;
} finally {
  source?.database.close();
}
