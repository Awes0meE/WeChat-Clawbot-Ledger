import assert from 'node:assert/strict';
import { readdirSync, lstatSync, readlinkSync, readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
const root = '/var/lib/clawbot-test';
const inventory = 'receipts/backup-file-inventory.json';
const mode = process.argv[2];
assert.ok(['save', 'check'].includes(mode));
assert.equal(JSON.parse(readFileSync(`${root}/config/initialized.json`)).project, 'clawbot-test');
const entries = [];
async function walk(relative) {
  if (relative === inventory) return;
  const path = `${root}/${relative}`, stat = lstatSync(path);
  if (stat.isSocket()) return; // A stopped runtime may leave a transient socket name.
  const record = { path: relative, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
  if (stat.isSymbolicLink()) entries.push({ ...record, type: 'symlink', target: readlinkSync(path) });
  else if (stat.isDirectory()) {
    entries.push({ ...record, type: 'directory' });
    for (const name of readdirSync(path).sort()) await walk(`${relative}/${name}`);
  } else {
    assert.ok(stat.isFile(), 'Unexpected persistent file type');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    entries.push({ ...record, type: 'file', bytes: stat.size, sha256: hash.digest('hex') });
  }
}
for (const name of ['bootstrap', 'codex', 'config', 'ledger', 'openclaw', 'receipts', 'secrets']) await walk(name);
const encoded = JSON.stringify(entries);
if (mode === 'save') writeFileSync(`${root}/${inventory}`, encoded, { mode: 0o600 });
else assert.ok(encoded === readFileSync(`${root}/${inventory}`, 'utf8'), 'Restored files do not match snapshot');
console.log(JSON.stringify({ status: `CLAWBOT_BACKUP_FILES_${mode === 'save' ? 'SAVED' : 'VERIFIED'}`, entries: entries.length,
  bytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) }));
