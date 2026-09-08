import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
// Expected change for renewal of one existing OpenAI OAuth profile. This is an
// offline comparison, not proof of a remotely accepted login or a new account.
export function expectedModelAuthorizationRenewal(store, state, profileId, credential, now = Date.now()) {
  const prior = store?.profiles?.[profileId];
  const text = value => typeof value === 'string' && value.trim().length > 0;
  assert.ok(store?.version === 1 && Object.hasOwn(store.profiles, profileId), 'CLAWBOT_RENEWAL_EXISTING_PROFILE_REQUIRED');
  assert.ok(prior?.provider === 'openai' && prior.type === 'oauth'
    && credential?.provider === 'openai' && credential.type === 'oauth', 'CLAWBOT_RENEWAL_OAUTH_ONLY');
  assert.ok(text(prior.accountId) && credential.accountId === prior.accountId, 'CLAWBOT_RENEWAL_ACCOUNT_METADATA_MISMATCH');
  assert.ok(text(credential.access) && text(credential.refresh) && Number.isFinite(credential.expires)
    && credential.expires > now, 'CLAWBOT_RENEWAL_CREDENTIAL_INCOMPLETE');
  const expectedStore = structuredClone(store), expectedState = structuredClone(state);
  expectedStore.profiles[profileId] = structuredClone(credential);
  const stats = expectedState?.usageStats?.[profileId];
  if (stats) {
    stats.errorCount = 0;
    // Pinned upstream resetAuthProfileFailureState clears precisely these
    // failure windows; last-used data and unrelated profile statistics remain.
    for (const key of ['blockedUntil', 'blockedReason', 'blockedSource', 'blockedModel', 'blockedScope',
      'cooldownUntil', 'cooldownReason', 'cooldownClassification', 'cooldownModel',
      'disabledUntil', 'disabledReason', 'failureCounts']) delete stats[key];
  }
  return { store: expectedStore, state: expectedState };
}
export function verifyModelAuthorizationRenewal(expected, store, state) {
  // Assertions never print stored credentials or account metadata.
  assert.ok(isDeepStrictEqual(expected.store, store), 'CLAWBOT_RENEWAL_UNEXPECTED_PROFILE_CHANGE');
  assert.ok(isDeepStrictEqual(expected.state, state), 'CLAWBOT_RENEWAL_UNEXPECTED_RUNTIME_STATE_CHANGE');
}

// Internal offline helper. The host operation must stop all consumers, retain
// a verified backup and audit unrelated database rows before/after calling it.
export async function renewExistingModelAuthorization({ agentDir, profileId, credential }) {
  const auth = await import('/app/dist/sqlite-tM5d-2v5.js');
  const normalize = await import('/app/dist/persisted-BQ67qhTy.js');
  const before = auth.o(agentDir), runtime = auth.a(agentDir);
  assert.ok(before.status === 'readable' && ['readable', 'missing'].includes(runtime.status), 'CLAWBOT_RENEWAL_STORE_UNREADABLE');
  const state = runtime.status === 'readable' ? runtime.raw : null;
  // The official writer normalizes its schema. Refuse before writing if that
  // would silently discard unknown auth metadata or unrelated usage fields.
  assert.ok(isDeepStrictEqual(normalize.n(normalize.i(before.raw)), before.raw)
    && isDeepStrictEqual(normalize.u(state ?? {}), state), 'CLAWBOT_RENEWAL_SCHEMA_WOULD_LOSE_DATA');
  const expected = expectedModelAuthorizationRenewal(before.raw, state, profileId, credential);
  const { u: saveLogin } = await import('/app/dist/profiles-DV3Jcdeb.js');
  await saveLogin({ agentDir, profileId, credential });
  const after = auth.o(agentDir), afterRuntime = auth.a(agentDir);
  assert.ok(after.status === 'readable' && ['readable', 'missing'].includes(afterRuntime.status), 'CLAWBOT_RENEWAL_STORE_UNREADABLE');
  verifyModelAuthorizationRenewal(expected, after.raw, afterRuntime.status === 'readable' ? afterRuntime.raw : null);
}
