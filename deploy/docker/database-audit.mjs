import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const encode = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? { $bigint: v.toString() } : v);
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
export function databaseAudit(path, { requireDelete = true, offlineWithoutWal = false } = {}) {
  let databasePath = path;
  if (offlineWithoutWal) {
    if (requireDelete) throw new Error('CLAWBOT_IMMUTABLE_AUDIT_REQUIRES_OFFLINE_MODE');
    // The caller has checked that no running container uses this offline
    // volume. A cleanly closed WAL database has no sidecars, yet ordinary
    // SQLite read-only open tries to create them on a read-only mount.
    // immutable is safe only when WAL is absent; never ignore a present WAL.
    try { lstatSync(`${path}-wal`); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      databasePath = `${pathToFileURL(path).href}?immutable=1`;
    }
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const journal = db.prepare('PRAGMA journal_mode').get().journal_mode;
    if (requireDelete ? journal !== 'delete' : !['delete', 'wal'].includes(journal)) throw new Error('CLAWBOT_DATABASE_SNAPSHOT_REQUIRED');
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('CLAWBOT_DATABASE_INTEGRITY');
    db.exec('BEGIN');
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
    const tables = {};
    for (const item of schema.filter((row) => row.type === 'table')) {
      const statement = db.prepare(`SELECT * FROM ${quote(item.name)}`); statement.setReadBigInts(true);
      const rows = [];
      for (const row of statement.iterate()) {
        if (rows.length >= 1000000) throw new Error('CLAWBOT_DATABASE_AUDIT_BUDGET');
        rows.push(hash(encode(row)));
      }
      rows.sort(); tables[item.name] = { count: rows.length, rowsSha256: hash(encode(rows)) };
    }
    db.exec('COMMIT');
    const evidence = { schemaSha256: hash(encode(schema)), tables,
      userVersion: db.prepare('PRAGMA user_version').get().user_version,
      applicationId: db.prepare('PRAGMA application_id').get().application_id };
    return { auditSha256: hash(encode(evidence)), tableCount: Object.keys(tables).length };
  } finally { db.close(); }
}
