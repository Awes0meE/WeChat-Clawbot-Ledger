import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

// Offline repair for the former runtime-only external CLI bootstrap. The host
// must stop consumers, verify a current backup, and compare unrelated state.
// A refreshed staged credential must belong to the existing production seed.
export async function bootstrapModelAuthorization({ agentDir, seed, credential }) {
  const profileId = 'openai:default';
  const text = value => typeof value === 'string' && value.trim().length > 0;
  for (const value of [seed, credential]) {
    assert.ok(value?.provider === 'openai' && value.type === 'oauth'
      && text(value.access) && text(value.refresh) && text(value.accountId), 'CLAWBOT_BOOTSTRAP_OAUTH_REQUIRED');
  }
  assert.ok(seed.accountId === credential.accountId, 'CLAWBOT_BOOTSTRAP_ACCOUNT_MISMATCH');
  assert.ok(Number.isFinite(credential.expires) && credential.expires > Date.now(), 'CLAWBOT_BOOTSTRAP_FRESH_AUTH_REQUIRED');
  const auth = await import('/app/dist/sqlite-tM5d-2v5.js');
  const normalize = await import('/app/dist/persisted-BQ67qhTy.js');
  const before = auth.o(agentDir), runtime = auth.a(agentDir);
  assert.ok(['readable', 'missing'].includes(before.status)
    && ['readable', 'missing'].includes(runtime.status), 'CLAWBOT_BOOTSTRAP_STORE_UNREADABLE');
  const store = before.status === 'readable' ? before.raw : { version: 1, profiles: {} };
  const state = runtime.status === 'readable' ? runtime.raw : null;
  assert.ok(!Object.hasOwn(store.profiles, profileId)
    && !Object.values(store.profiles).some(p => p.provider === 'openai'), 'CLAWBOT_BOOTSTRAP_ALREADY_MANAGED');
  assert.ok(isDeepStrictEqual(normalize.n(normalize.i(store)), store)
    && isDeepStrictEqual(normalize.u(state ?? {}), state), 'CLAWBOT_BOOTSTRAP_UNKNOWN_METADATA');
  const expected = structuredClone(store);
  expected.profiles[profileId] = structuredClone(credential);
  const { u: saveLogin } = await import('/app/dist/profiles-DV3Jcdeb.js');
  await saveLogin({ agentDir, profileId, credential });
  assert.ok(isDeepStrictEqual(auth.o(agentDir).raw, expected), 'CLAWBOT_BOOTSTRAP_UNEXPECTED_PROFILE_CHANGE');
  assert.ok(isDeepStrictEqual(auth.a(agentDir).raw ?? null, state), 'CLAWBOT_BOOTSTRAP_UNEXPECTED_STATE_CHANGE');
}
