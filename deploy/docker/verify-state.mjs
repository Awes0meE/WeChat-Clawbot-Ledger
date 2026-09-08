import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const root = '/var/lib/clawbot-test';
assert.deepEqual(JSON.parse(readFileSync(`${root}/config/initialized.json`)), { project: 'clawbot-test', version: 1 });
const mode = process.argv[2];
assert.ok(['save', 'check'].includes(mode));
const hash = (v) => createHash('sha256').update(v).digest('hex');
const json = (v) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? `${x}n` : x);
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const ledgerFiles = readdirSync(`${root}/ledger/data`).filter((file) => /\.(db|sqlite|sqlite3)$/.test(file));
assert.equal(ledgerFiles.length, 1, 'Expected one isolated ledger database');
const databases = { ledger: `${root}/ledger/data/${ledgerFiles[0]}`, receipts: `${root}/receipts/message-receipts.sqlite` };
const evidence = {};
for (const [kind, path] of Object.entries(databases)) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    db.exec('BEGIN');
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
    evidence[kind] = {};
    for (const table of tables) {
      const statement = db.prepare(`SELECT * FROM ${quote(table.name)}`);
      statement.setReadBigInts(true);
      // Persist only hashes and counts in the isolated volume, never rows.
      const rows = statement.all().map((row) => hash(json(row))).sort();
      evidence[kind][table.name] = { schema: hash(table.sql ?? ''), count: rows.length, content: hash(json(rows)) };
    }
    db.exec('COMMIT');
  } finally { db.close(); }
}
const snapshot = `${root}/receipts/p1-state-snapshot.json`;
if (mode === 'save') writeFileSync(snapshot, json(evidence), { mode: 0o600 });
else {
  const before = JSON.parse(readFileSync(snapshot));
  // Do not use deepEqual: a failed assertion must not print stored evidence.
  assert.ok(json(before) === json(evidence), 'Persistent database contents changed across recovery');
}
console.log(JSON.stringify({ status: mode === 'save' ? 'CLAWBOT_STATE_SNAPSHOT_SAVED' : 'CLAWBOT_STATE_RECOVERY_INTEGRITY_OK', tables: Object.fromEntries(Object.entries(evidence).map(([k, v]) => [k, Object.keys(v).length])) }));
