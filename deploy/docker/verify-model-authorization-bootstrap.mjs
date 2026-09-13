import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { bootstrapModelAuthorization } from './bootstrap-model-authorization.mjs';
import { authorizationStateAudit } from './authorization-state-audit.mjs';
import * as auth from '/app/dist/sqlite-tM5d-2v5.js';
import { u as save } from '/app/dist/profiles-DV3Jcdeb.js';

// Network-none fixture with tmpfs only; never mount production into this test.
assert.equal(process.env.OPENCLAW_STATE_DIR, '/tmp/writer');
assert.equal(process.env.CODEX_HOME, '/tmp/unused');
const root = '/tmp/target', agentDir = `${root}/agents/bookkeeper/agent`;
assert.ok(!fs.existsSync(root));
fs.mkdirSync(agentDir, { recursive: true });
await save({ agentDir, profileId: 'synthetic-init', credential: { type: 'api_key', provider: 'synthetic', key: 'fixture' } });
const db = new DatabaseSync(`${agentDir}/openclaw-agent.sqlite`, { allowExtension: true });
// Simulate an existing history database with no persisted auth profile.
db.exec(`DELETE FROM auth_profile_store; DELETE FROM auth_profile_state;
  CREATE TABLE unknown_data(id INTEGER PRIMARY KEY, payload BLOB);
  INSERT INTO unknown_data VALUES(9223372036854775806, x'00ff');`);
createRequire('/app/package.json')('sqlite-vec').load(db);
db.exec('CREATE VIRTUAL TABLE synthetic_vectors USING vec0(embedding float[2]);');
db.close();
const seed = { provider: 'openai', type: 'oauth', accountId: 'synthetic', access: 'old', refresh: 'old-refresh', expires: 1 };
const credential = { ...seed, access: 'new', refresh: 'new-refresh', expires: Date.now() + 3600000 };
const audit = () => authorizationStateAudit(root, { bootstrapModelProfile: true });
const before = await audit();
for (const invalid of [{ ...credential, accountId: 'wrong' }, { ...credential, expires: 1 }, { ...credential, refresh: '' }]) {
  await assert.rejects(() => bootstrapModelAuthorization({ agentDir, seed, credential: invalid }));
  assert.equal(await audit(), before);
}
await bootstrapModelAuthorization({ agentDir, seed, credential });
assert.equal(await audit(), before);
await assert.rejects(() => bootstrapModelAuthorization({ agentDir, seed, credential }));
assert.equal(await audit(), before);
auth.t();
console.log('BOOTSTRAP_ACCOUNT_BINDING_PERSISTENCE_UNKNOWN_ROWS_AND_DUPLICATE_REJECTION_PASSED');
