import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundAuthorizationChecks } from '../../../scripts/mac/background-authorization-checks.mjs';
const turn = () => new Promise(resolve => setImmediate(resolve));
test('page reads do not await diagnostics or start duplicate concurrent checks', async () => {
  const cache = backgroundAuthorizationChecks(); let done, calls = 0;
  const action = () => { calls++; return new Promise(resolve => { done = resolve; }); };
  assert.equal(cache.read('model', action), undefined); assert.equal(cache.pending, true);
  assert.equal(cache.read('model', action), undefined); await turn(); assert.equal(calls, 1);
  done({ state: 'credentials-present' }); await turn();
  assert.equal(cache.pending, false); assert.equal(cache.read('model', action).state, 'credentials-present'); assert.equal(calls, 1);
});
test('scope invalidation prevents an old in-flight result from populating a new runtime cache', async () => {
  const cache = backgroundAuthorizationChecks(); let oldDone, newDone;
  cache.read('ledger', () => new Promise(resolve => { oldDone = resolve; })); await turn(); cache.invalidate();
  cache.read('ledger', () => new Promise(resolve => { newDone = resolve; })); await turn();
  oldDone('old'); await turn(); assert.equal(cache.read('ledger', () => { throw Error(); }), undefined);
  newDone('new'); await turn(); assert.equal(cache.read('ledger', () => { throw Error(); }), 'new');
});
test('five-minute refresh failures remove the previous result and never escape as raw errors', async () => {
  let now = 0; const cache = backgroundAuthorizationChecks({ now: () => now });
  cache.read('weixin', async () => 'previous'); await turn(); assert.equal(cache.read('weixin', () => { throw Error(); }), 'previous');
  now = 300000; assert.equal(cache.read('weixin', async () => { throw Error('SECRET'); }), 'previous'); await turn();
  assert.equal(cache.pending, false); assert.equal(cache.read('weixin', () => { throw Error(); }), undefined);
});
test('short-lived tunnel evidence refreshes independently without repeating credential checks', async () => {
  let now = 0, tunnelCalls = 0, modelCalls = 0; const cache = backgroundAuthorizationChecks({ now: () => now });
  const tunnel = async () => ({ observedAt: now, sequence: ++tunnelCalls });
  const model = async () => { modelCalls++; return 'credentials'; };
  cache.read('tunnel', tunnel, { refreshMs: 2000 }); cache.read('model', model); await turn();
  now = 5000; assert.equal(cache.read('tunnel', tunnel, { refreshMs: 2000 }).observedAt, 0);
  cache.read('tunnel', tunnel, { refreshMs: 2000 }); cache.read('model', model); await turn();
  assert.equal(cache.read('tunnel', tunnel, { refreshMs: 2000 }).observedAt, 5000);
  assert.equal(tunnelCalls, 2); assert.equal(modelCalls, 1);
});
