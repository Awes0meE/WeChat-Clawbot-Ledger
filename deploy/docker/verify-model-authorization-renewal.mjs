import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { expectedModelAuthorizationRenewal, verifyModelAuthorizationRenewal, renewExistingModelAuthorization } from './model-authorization-renewal.mjs';
// Network-none, tmpfs-only fixture; never mount real state into this verifier.
const root = '/tmp/clawbot-auth-renewal-check', stateRoot = `${root}/openclaw`;
assert.equal(process.env.OPENCLAW_STATE_DIR, stateRoot);
assert.equal(process.env.OPENCLAW_CONFIG_PATH, `${stateRoot}/openclaw.json`);
assert.equal(process.env.CODEX_HOME, `${root}/codex`);
assert.ok(!fs.existsSync(root));
const agent = `${stateRoot}/agents/bookkeeper/agent`;
fs.mkdirSync(agent, { recursive: true, mode: 0o700 });
fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({ agents: { entries: { bookkeeper: {} } } }), { mode: 0o600 });
const { u: saveLogin } = await import('/app/dist/profiles-DV3Jcdeb.js');
const auth = await import('/app/dist/sqlite-tM5d-2v5.js');
const id = 'openai:renewal-fixture', other = 'openai:untouched-fixture';
const old = { provider: 'openai', type: 'oauth', accountId: 'synthetic-account', access: 'synthetic-old', refresh: 'synthetic-old-refresh', expires: Date.now() + 3600000 };
await saveLogin({ profileId: id, credential: old, agentDir: agent });
await saveLogin({ profileId: other, credential: { ...old, accountId: 'synthetic-other' }, agentDir: agent });
const dbPath = `${agent}/openclaw-agent.sqlite`;
const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE unknown_business_records(id INTEGER PRIMARY KEY, payload BLOB)');
db.exec("ALTER TABLE auth_profile_store ADD COLUMN future_metadata TEXT DEFAULT 'preserve'");
db.prepare('INSERT INTO auth_profile_store(store_key,store_json,updated_at) VALUES(?,?,?)').run('unrelated-fixture', '{}', 17);
db.prepare('INSERT INTO unknown_business_records VALUES(?, ?)').run(9007199254740993n, Buffer.from([0, 1, 255]));
const runtime = { version: 1, order: { openai: [id, other] }, lastGood: { openai: id }, usageStats: {
  [id]: { errorCount: 3, lastUsed: 123, disabledUntil: Date.now() + 3600000, disabledReason: 'auth_permanent', customCounter: 7 },
  [other]: { errorCount: 1, lastUsed: 456, cooldownUntil: Date.now() + 3600000, cooldownReason: 'timeout' },
} };
auth.v(runtime, agent);
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? `${v}n` : v);
function audit(current = db) {
  assert.equal(current.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const result = {};
  for (const table of current.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
    const query = current.prepare(`SELECT * FROM "${table.name.replaceAll('"','""')}"`); query.setReadBigInts(true);
    const rows = query.all().map(row => {
      // Only the primary auth cells (checked in full below) and their write
      // timestamps may change. All other rows in these same tables still count.
      if ((table.name === 'auth_profile_store' && row.store_key === 'primary')
        || (table.name === 'auth_profile_state' && row.state_key === 'primary')) {
        delete row[table.name === 'auth_profile_store' ? 'store_json' : 'state_json']; delete row.updated_at;
      }
      return hash(json(row));
    }).sort();
    result[table.name] = { schema: hash(table.sql ?? ''), rows };
  }
  return hash(json(result));
}
const unknownBefore = audit();
await assert.rejects(() => renewExistingModelAuthorization({ agentDir: agent, profileId: id, credential: old }), /CLAWBOT_RENEWAL_SCHEMA_WOULD_LOSE_DATA/);
assert.equal(audit(), unknownBefore);
assert.equal(auth.a(agent).raw.usageStats[id].customCounter, 7);
// Use supported upstream metadata for the positive renewal fixture.
delete runtime.usageStats[id].customCounter; auth.v(runtime, agent);
const sharedDb = new DatabaseSync(`${stateRoot}/state/openclaw.sqlite`, { readOnly: true });
const sharedBefore = audit(sharedDb);
const beforeAudit = audit(), beforeConfig = hash(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH));
const before = auth.o(agent), beforeState = auth.a(agent);
assert.equal(before.status, 'readable'); assert.equal(beforeState.status, 'readable');
const fresh = { ...old, access: 'synthetic-new', refresh: 'synthetic-new-refresh', expires: Date.now() + 7200000 };
const expected = expectedModelAuthorizationRenewal(before.raw, beforeState.raw, id, fresh);
for (const bad of [{ ...fresh, accountId: 'different-account' }, { ...fresh, type: 'api_key' }, { ...fresh, expires: 1 }, { ...fresh, refresh: '' }]) {
  assert.throws(() => expectedModelAuthorizationRenewal(before.raw, beforeState.raw, id, bad));
}
await renewExistingModelAuthorization({ profileId: id, credential: fresh, agentDir: agent });
verifyModelAuthorizationRenewal(expected, auth.o(agent).raw, auth.a(agent).raw);
assert.equal(audit(), beforeAudit, 'Unrelated database rows changed');
assert.equal(hash(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH)), beforeConfig);
assert.equal(audit(sharedDb), sharedBefore, 'Shared database changed');
db.close(); sharedDb.close(); auth.t();
console.log('CLAWBOT_OFFICIAL_AUTH_RENEWAL_SINGLE_PROFILE_AND_UNKNOWN_ROWS_PRESERVED');
