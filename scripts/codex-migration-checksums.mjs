import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CODEX_DATABASE_FAMILIES = Object.freeze({
  'state_5.sqlite': 'migrations', 'logs_2.sqlite': 'logs_migrations',
  'queue_1.sqlite': 'queue_migrations', 'thread_history_1.sqlite': 'thread_history_migrations',
  'goals_1.sqlite': 'goals_migrations', 'memories_1.sqlite': 'memory_migrations',
});
const hash = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
const encode = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? { bigint: String(v) } : v);
const quote = value => `"${value.replaceAll('"', '""')}"`;
function ordinaryFile(path) {
  const s = lstatSync(path);
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1, 'Ordinary private file required');
  return s;
}
function openOffline(path) {
  ordinaryFile(path);
  // Caller must establish quiescence. A present WAL is always included.
  return new DatabaseSync(existsSync(`${path}-wal`) ? path : `${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
}
function migrations(db) {
  return db.prepare('SELECT version, description, success, hex(checksum) AS checksum FROM _sqlx_migrations ORDER BY version').all();
}
function sourceFingerprint(path) {
  return ['', '-wal', '-journal'].map(suffix => {
    const file = path + suffix;
    if (!existsSync(file)) return null;
    ordinaryFile(file); return hash(readFileSync(file));
  });
}
// Preserve every table, unknown field, BLOB and 64-bit value. Only the checksum
// column of the migration bookkeeping table is permitted to differ.
export function auditSqliteData(db, ignoredColumns = {}) {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
  const tables = {};
  for (const { name } of schema.filter(row => row.type === 'table')) {
    const statement = db.prepare(`SELECT * FROM ${quote(name)}`); statement.setReadBigInts(true);
    const rows = [];
    for (const row of statement.iterate()) {
      assert.ok(rows.length < 1000000, 'Audit row budget exceeded');
      for (const column of ignoredColumns[name] ?? []) delete row[column];
      rows.push(hash(encode(row)));
    }
    tables[name] = { count: rows.length, sha256: hash(encode(rows.sort())) };
  }
  return hash(encode({ schema, tables, userVersion: db.prepare('PRAGMA user_version').get().user_version,
    applicationId: db.prepare('PRAGMA application_id').get().application_id }));
}
const dataAudit = db => auditSqliteData(db, { _sqlx_migrations: ['checksum'] });
function sqlChecksums(directory) {
  assert.equal(realpathSync(directory), directory);
  const result = new Map();
  for (const name of readdirSync(directory).sort()) {
    const match = /^(\d+)_[-a-z0-9_]+\.sql$/.exec(name);
    assert.ok(match, 'Unrecognized migration source');
    const path = join(directory, name); assert.ok(ordinaryFile(path).size < 1024 * 1024);
    const bytes = readFileSync(path), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assert.ok(!text.includes('\0') && !/\r(?!\n)/.test(text), 'Unsupported SQL encoding');
    const version = Number(match[1]); assert.ok(Number.isSafeInteger(version) && version > 0 && !result.has(version));
    const lf = text.replaceAll('\r\n', '\n');
    result.set(version, { lf: hash(lf, 'sha384'), crlf: hash(lf.replaceAll('\n', '\r\n'), 'sha384') });
  }
  return result;
}

/**
 * Create repaired copies of all six databases; never edit the input directory.
 * The caller supplies SQL from the pinned official source and migration rows
 * independently observed in a fresh database made by the exact target binary.
 * Caller must keep source databases offline for the complete operation.
 */
export async function prepareCodexChecksumCopies({ sourceDirectory, sqlDirectory, targetReference, outputDirectory }) {
  assert.equal(realpathSync(sourceDirectory), sourceDirectory);
  assert.equal(realpathSync(sqlDirectory), sqlDirectory);
  assert.ok(!existsSync(outputDirectory), 'Output must be a new directory');
  assert.deepEqual(Object.keys(targetReference.databases).sort(), Object.keys(CODEX_DATABASE_FAMILIES).sort());
  const plans = [];
  // Validate all families before producing any candidate. A genuine SQL change,
  // failed migration or missing target version must never be relabelled.
  for (const [name, family] of Object.entries(CODEX_DATABASE_FAMILIES)) {
    const source = join(sourceDirectory, name), fingerprints = sourceFingerprint(source);
    const db = openOffline(source);
    try {
      const rows = migrations(db), target = targetReference.databases[name], sources = sqlChecksums(join(sqlDirectory, family));
      assert.equal(rows.length, target.length, 'Different migration versions require a separate upgrade');
      assert.equal(new Set(target.map(row => row.version)).size, target.length);
      const updates = [];
      for (const row of rows) {
        const wanted = target.find(item => item.version === row.version), variants = sources.get(row.version);
        assert.ok(variants && wanted && row.success === 1 && (wanted.success === undefined || wanted.success === 1));
        assert.equal(row.description, wanted.description, 'Migration description differs');
        const old = row.checksum.toLowerCase(), next = wanted.checksum.toLowerCase();
        assert.ok([variants.lf, variants.crlf].includes(old) && [variants.lf, variants.crlf].includes(next),
          'Checksum is not explained solely by SQL line endings');
        if (old !== next) updates.push({ version: row.version, old, next });
      }
      plans.push({ name, source, fingerprints, updates, target, dataSha256: dataAudit(db) });
    } finally { db.close(); }
  }
  mkdirSync(outputDirectory, { mode: 0o700 });
  const report = [];
  for (const plan of plans) {
    assert.deepEqual(sourceFingerprint(plan.source), plan.fingerprints, 'Source changed after preflight');
    const source = openOffline(plan.source), destination = join(outputDirectory, plan.name);
    try { await backup(source, destination); } finally { source.close(); }
    chmodSync(destination, 0o600);
    const db = new DatabaseSync(destination);
    try {
      assert.equal(dataAudit(db), plan.dataSha256);
      db.exec('BEGIN IMMEDIATE');
      try {
        const update = db.prepare('UPDATE _sqlx_migrations SET checksum=? WHERE version=? AND hex(checksum)=?');
        for (const row of plan.updates) assert.equal(update.run(Buffer.from(row.next, 'hex'), row.version, row.old.toUpperCase()).changes, 1);
        assert.equal(dataAudit(db), plan.dataSha256, 'Non-checksum data changed');
        assert.deepEqual(migrations(db).map(row => row.checksum.toLowerCase()), plan.target.map(row => row.checksum.toLowerCase()));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      db.exec('PRAGMA journal_mode=DELETE');
      assert.equal(dataAudit(db), plan.dataSha256);
    } finally { db.close(); }
    assert.deepEqual(sourceFingerprint(plan.source), plan.fingerprints, 'Source changed during copy');
    report.push({ database: plan.name, changedChecksums: plan.updates.length, dataSha256: plan.dataSha256 });
  }
  return { status: 'CLAWBOT_CODEX_CHECKSUM_COPIES_VERIFIED', databases: report };
}
