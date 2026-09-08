import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CODEX_DATABASE_FAMILIES, prepareCodexChecksumCopies } from '../../../scripts/codex-migration-checksums.mjs';
const digest = text => createHash('sha384').update(text).digest('hex');
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-codex-checksums-'))), sourceDirectory = join(root, 'source'), sqlDirectory = join(root, 'sql');
  mkdirSync(sourceDirectory); mkdirSync(sqlDirectory); const databases = {};
  for (const [name, family] of Object.entries(CODEX_DATABASE_FAMILIES)) {
    const sql = 'CREATE TABLE payload (id INTEGER PRIMARY KEY, body BLOB);\n';
    mkdirSync(join(sqlDirectory, family)); writeFileSync(join(sqlDirectory, family, '0001_payload.sql'), sql);
    const db = new DatabaseSync(join(sourceDirectory, name));
    db.exec('CREATE TABLE _sqlx_migrations (version INTEGER PRIMARY KEY,description TEXT,success INTEGER,checksum BLOB,unknown_field TEXT)');
    db.prepare('INSERT INTO _sqlx_migrations VALUES(1,?,1,?,?)').run('payload', Buffer.from(digest(sql.replaceAll('\n', '\r\n')), 'hex'), 'retain');
    db.exec(sql); db.prepare('INSERT INTO payload VALUES(?,?)').run(9223372036854775806n, Buffer.from([0, 1, 255])); db.close();
    databases[name] = [{ version: 1, description: 'payload', success: 1, checksum: digest(sql) }];
  }
  return { root, sourceDirectory, sqlDirectory, targetReference: { databases }, outputDirectory: join(root, 'copies') };
}
test('line-ending-only repair preserves unknown data, committed WAL, and original databases', async () => {
  const f = fixture();
  try {
    const source = join(f.sourceDirectory, 'state_5.sqlite');
    const child = spawnSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec("PRAGMA journal_mode=WAL;INSERT INTO payload VALUES(7,X'1234')");process.exit(0)`, source]);
    assert.equal(child.status, 0); assert.ok(existsSync(source + '-wal'));
    const original = readFileSync(source), wal = readFileSync(source + '-wal');
    const report = await prepareCodexChecksumCopies(f);
    assert.equal(report.databases.length, 6); assert.ok(report.databases.every(row => row.changedChecksums === 1));
    assert.deepEqual(readFileSync(source), original); assert.deepEqual(readFileSync(source + '-wal'), wal);
    const output = new DatabaseSync(join(f.outputDirectory, 'state_5.sqlite'), { readOnly: true });
    const query = output.prepare('SELECT * FROM payload ORDER BY id'); query.setReadBigInts(true);
    assert.deepEqual(query.all().map(row => [row.id, [...row.body]]), [[7n, [18, 52]], [9223372036854775806n, [0, 1, 255]]]);
    assert.equal(output.prepare('SELECT unknown_field FROM _sqlx_migrations').get().unknown_field, 'retain'); output.close();
    await assert.rejects(prepareCodexChecksumCopies(f), /new directory/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('genuine SQL drift in the last database refuses all output before any repair', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.sqlDirectory, 'memory_migrations/0001_payload.sql'), 'CREATE TABLE different (x TEXT);\n');
    await assert.rejects(prepareCodexChecksumCopies(f), /line endings/);
    assert.equal(existsSync(f.outputDirectory), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('already-compatible copies remain unchanged and the Windows target direction is supported', async () => {
  const f = fixture();
  try {
    for (const rows of Object.values(f.targetReference.databases)) rows[0].checksum = digest('CREATE TABLE payload (id INTEGER PRIMARY KEY, body BLOB);\r\n');
    const same = await prepareCodexChecksumCopies(f); assert.ok(same.databases.every(row => row.changedChecksums === 0));
    const reference = structuredClone(f.targetReference);
    for (const rows of Object.values(f.targetReference.databases)) rows[0].checksum = digest('CREATE TABLE payload (id INTEGER PRIMARY KEY, body BLOB);\n');
    const linux = join(f.root, 'linux'); await prepareCodexChecksumCopies({ ...f, outputDirectory: linux });
    const reverse = await prepareCodexChecksumCopies({ ...f, sourceDirectory: linux, targetReference: reference, outputDirectory: join(f.root, 'windows') });
    assert.ok(reverse.databases.every(row => row.changedChecksums === 1));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
