import assert from 'node:assert/strict';
import { readdirSync, lstatSync, readlinkSync, createReadStream, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? { sqliteInteger: v.toString() } : v);
const agentDB = 'agents/bookkeeper/agent/openclaw-agent.sqlite';
const sharedDB = 'state/openclaw.sqlite';
export async function authorizationStateAudit(root) {
  assert.equal(realpathSync(root), root);
  const databases = [agentDB, sharedDB], entries = []; let bytes = 0;
  async function walk(relative) {
    assert.ok(entries.length < 100000 && relative.length < 4096 && relative.split('/').length < 64);
    const path = join(root, relative), stat = lstatSync(path);
    if (stat.isSocket()) return;
    if (databases.some(db => ['-wal', '-shm', '-journal'].some(suffix => relative === db + suffix))) {
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1); return;
    }
    const row = { path: relative, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
    if (stat.isDirectory()) {
      entries.push({ ...row, type: 'directory' });
      for (const name of readdirSync(path).sort()) await walk(relative ? `${relative}/${name}` : name);
    } else if (stat.isSymbolicLink()) entries.push({ ...row, type: 'symlink', target: readlinkSync(path) });
    else {
      assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 4 * 2 ** 30);
      if (databases.includes(relative)) entries.push({ ...row, type: 'audited-database' });
      else {
        bytes += stat.size; assert.ok(bytes <= 20 * 2 ** 30);
        const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk);
        entries.push({ ...row, type: 'file', bytes: stat.size, sha256: digest.digest('hex') });
      }
    }
  }
  await walk('');
  const evidence = {};
  for (const relative of databases) {
    const path = join(root, relative);
    if (!entries.some(e => e.path === relative)) continue;
    assert.ok(entries.find(e => e.path === relative).type === 'audited-database');
    let databasePath = path;
    try { lstatSync(path + '-wal'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; databasePath = pathToFileURL(path).href + '?immutable=1'; }
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); db.exec('BEGIN');
      const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
      const tables = {};
      for (const table of schema.filter(row => row.type === 'table')) {
        const statement = db.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`); statement.setReadBigInts(true);
        const rows = [];
        for (const row of statement.iterate()) {
          assert.ok(rows.length < 1000000);
          // The renewal helper separately compares the full primary JSON cells.
          // Preserve every other column, including unknown future columns.
          if (relative === agentDB && ((table.name === 'auth_profile_store' && row.store_key === 'primary')
            || (table.name === 'auth_profile_state' && row.state_key === 'primary'))) {
            delete row[table.name === 'auth_profile_store' ? 'store_json' : 'state_json']; delete row.updated_at;
          }
          rows.push(hash(encode(row)));
        }
        tables[table.name] = hash(encode(rows.sort()));
      }
      db.exec('COMMIT');
      evidence[relative] = { schema: hash(encode(schema)), tables,
        userVersion: db.prepare('PRAGMA user_version').get().user_version,
        applicationId: db.prepare('PRAGMA application_id').get().application_id };
    } finally { db.close(); }
  }
  return hash(encode({ entries, evidence }));
}
