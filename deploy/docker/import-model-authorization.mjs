import assert from 'node:assert/strict';
import { mkdirSync, copyFileSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { expectedModelAuthorizationRenewal } from './model-authorization-renewal.mjs';
import { authorizationStateAudit } from './authorization-state-audit.mjs';
const root = '/var/lib/clawbot/openclaw', agent = `${root}/agents/bookkeeper/agent`;
const source = '/authorization-source/openclaw/agents/bookkeeper/agent';
const temporary = '/tmp/clawbot-auth-import', copied = `${temporary}/source/agents/bookkeeper/agent`;
const targetCopy = `${temporary}/target/agents/bookkeeper/agent`;
const hash = value => createHash('sha256').update(value).digest('hex');
let ownsTemporary = false;
let phase = 'preflight';
try {
  const [action, expectedBinding] = process.argv.slice(2);
  assert.ok(['inspect', 'apply'].includes(action));
  assert.equal(process.env.OPENCLAW_STATE_DIR, root);
  assert.equal(process.env.OPENCLAW_CONFIG_PATH, '/run/clawbot-runtime/openclaw.json');
  assert.equal(realpathSync(root), root); assert.equal(realpathSync(agent), agent);
  assert.equal(realpathSync(source), source);
  mkdirSync(temporary, { mode: 0o700 }); ownsTemporary = true; mkdirSync(copied, { recursive: true, mode: 0o700 });
  let bytes = 0;
  function copyDatabase(from, to) {
    const evidence = [];
    // A rollback journal can contain recovery data. This WAL-based path must
    // not silently omit it and read an inconsistent standalone database.
    try { assert.equal(lstatSync(join(from, 'openclaw-agent.sqlite-journal')).size, 0); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const suffix of ['', '-wal', '-shm']) {
      const name = `openclaw-agent.sqlite${suffix}`, path = join(from, name);
      let stat; try { stat = lstatSync(path); } catch (e) { if (suffix && e.code === 'ENOENT') continue; throw e; }
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
      bytes += stat.size; assert.ok(bytes <= 64 * 2 ** 20);
      const digest = hash(readFileSync(path)); copyFileSync(path, join(to, name));
      assert.equal(hash(readFileSync(join(to, name))), digest); evidence.push([name, digest]);
    }
    return evidence;
  }
  const sourceEvidence = copyDatabase(source, copied);
  mkdirSync(targetCopy, { recursive: true, mode: 0o700 }); copyDatabase(agent, targetCopy);
  const auth = await import('/app/dist/sqlite-tM5d-2v5.js');
  const staged = auth.o(copied), target = auth.o(targetCopy), runtime = auth.a(targetCopy);
  assert.ok(staged.status === 'readable' && target.status === 'readable');
  assert.ok(['readable', 'missing'].includes(runtime.status));
  const stagedProfiles = Object.values(staged.raw.profiles ?? {});
  assert.equal(stagedProfiles.length, 1, 'CLAWBOT_AUTH_SOURCE_MUST_HAVE_ONE_PROFILE');
  const credential = stagedProfiles[0];
  const matching = Object.entries(target.raw.profiles ?? {}).filter(([, old]) => old?.provider === 'openai'
    && old.type === 'oauth' && typeof old.accountId === 'string' && old.accountId && old.accountId === credential?.accountId);
  assert.equal(matching.length, 1, 'CLAWBOT_AUTH_TARGET_ACCOUNT_AMBIGUOUS_OR_MISSING');
  const profileId = matching[0][0], state = runtime.status === 'readable' ? runtime.raw : null;
  expectedModelAuthorizationRenewal(target.raw, state, profileId, credential);
  phase = 'audit-before';
  const audit = await authorizationStateAudit(root);
  const binding = hash(JSON.stringify({ sourceEvidence, target: target.raw, state, audit }));
  if (action === 'apply') {
    phase = 'binding';
    assert.equal(binding, expectedBinding, 'CLAWBOT_AUTH_IMPORT_INPUT_CHANGED');
    phase = 'renew';
    // Official persistence also registers a process/database lease in shared
    // state. Confine that bookkeeping to tmpfs while explicitly targeting only
    // the existing agent database. Credentials travel over stdin, never argv.
    const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
      try {
        let input = ''; for await (const chunk of process.stdin) input += chunk;
        const { helper, ...request } = JSON.parse(input);
        const { renewExistingModelAuthorization } = await import(helper);
        await renewExistingModelAuthorization(request);
      } catch { process.exitCode = 1; }
    `], { env: { ...process.env, OPENCLAW_STATE_DIR: `${temporary}/writer` },
      input: JSON.stringify({ helper: new URL('./model-authorization-renewal.mjs', import.meta.url).href,
        agentDir: agent, profileId, credential }), encoding: 'utf8', timeout: 60000, maxBuffer: 65536 });
    assert.equal(writer.status, 0, 'CLAWBOT_AUTH_OFFICIAL_WRITER_FAILED');
    phase = 'audit-after';
    assert.equal(await authorizationStateAudit(root), audit, 'CLAWBOT_AUTH_IMPORT_UNRELATED_DATA_CHANGED');
  }
  phase = 'source-unchanged';
  for (const [name, digest] of sourceEvidence) assert.equal(hash(readFileSync(join(source, name))), digest);
  auth.t();
  console.log(JSON.stringify({ status: action === 'inspect' ? 'CLAWBOT_AUTH_IMPORT_READY_FOR_REVIEW' : 'CLAWBOT_AUTH_IMPORTED_MAINTENANCE_REQUIRED',
    binding, unrelatedStatePreserved: true, remoteVerified: false }));
} catch { console.error(`CLAWBOT_AUTH_IMPORT_REFUSED_OR_FAILED_MAINTENANCE_REQUIRED:${phase}`); process.exitCode = 1; }
finally { if (ownsTemporary) rmSync(temporary, { recursive: true, force: true }); }
