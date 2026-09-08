import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectLedgerAuthorization, visibleLedgerAuthorization } from '../../../scripts/mac/ledger-authorization-inspection.mjs';
const sourceCommit = 'a'.repeat(40), pair = { origin: 'b'.repeat(64), openclaw: 'c'.repeat(64) };
const startedAt = '2026-09-08T00:00:00.000Z';
const originImage = `sha256:${'d'.repeat(64)}`, runtimeImage = `sha256:${'e'.repeat(64)}`;
function harness(options = {}) {
  let inspections = 0, identities = 0; const calls = [];
  return { calls, inspect: async () => {
    if (++inspections > 1 && options.replaced) return { ...pair, [options.replaced]: 'f'.repeat(64) };
    return pair;
  }, run: async (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'inspect') {
      identities++;
      return ['origin', 'openclaw'].map(role => JSON.stringify({ id: pair[role], image: role === 'origin' ? originImage : runtimeImage,
        startedAt: identities > 1 && options.restarted === role ? '2026-09-08T00:01:00.000Z' : startedAt,
        running: options.stopped !== role })).join('\n');
    }
    assert.deepEqual(args, ['exec', '-i', pair.openclaw, 'node', '--input-type=module', '-']);
    assert.match(input, /http:\/\/127\.0\.0\.1:18888/);
    assert.match(input, /stat\.uid !== process\.getuid\(\)/);
    return JSON.stringify({ version: 1, observedAt: new Date().toISOString(), businessWrites: false,
      accountIdentityVerified: false, restartRecommended: false,
      http: { state: 'accepted-read-only', token: 'SECRET' }, mcp: { state: 'credential-expired' },
      rawAccount: 'PRIVATE', ...options.report });
  } };
}
const inspect = options => inspectLedgerAuthorization({ ...harness(options), profile: 'isolated-test', sourceCommit });
const expected = { sourceCommit, runtimeImage, containerId: pair.openclaw, containerStartedAt: startedAt,
  originId: pair.origin, originImage, originStartedAt: startedAt };
test('ledger inspection projects only fixed results and binds both running services', async () => {
  const report = await inspect();
  assert.equal(report.http.state, 'accepted-read-only'); assert.equal(report.mcp.state, 'credential-expired');
  assert.equal(report.containerId, pair.openclaw); assert.equal(report.originId, pair.origin);
  assert.doesNotMatch(JSON.stringify(report), /SECRET|PRIVATE|rawAccount/);
});
test('replaced, restarted or stopped origin and agent cannot inherit a probe result', async () => {
  for (const role of ['origin', 'openclaw']) for (const option of ['replaced', 'restarted', 'stopped']) {
    await assert.rejects(inspect({ [option]: role }));
  }
});
test('unknown probe fields are dropped and unsafe status or future observations fail closed', async () => {
  for (const report of [{ businessWrites: true }, { http: { state: 'print SECRET' } },
    { mcp: { state: 'accepted-read-only', sessionCleanup: 'SECRET' } },
    { observedAt: new Date(Date.now() + 60000).toISOString() }]) await assert.rejects(inspect({ report }));
});
test('page requires current host, both container identities and fresh probe time', async () => {
  const report = await inspect(), now = Date.parse(report.observedAt);
  assert.equal(visibleLedgerAuthorization(report, expected, now).http.state, 'accepted-read-only');
  const stale = visibleLedgerAuthorization(report, expected, now + 6 * 60000 + 1);
  assert.equal(stale.state, 'stale'); assert.equal(stale.http.state, 'inspection-unavailable');
  assert.equal(visibleLedgerAuthorization(report, expected, now - 1).state, 'inspection-unavailable');
  for (const key of Object.keys(expected)) assert.equal(visibleLedgerAuthorization(report, { ...expected, [key]: 'different' }, now).state, 'inspection-unavailable');
  assert.equal(visibleLedgerAuthorization(report, undefined, now).state, 'inspection-unavailable');
  assert.equal(visibleLedgerAuthorization({ ...report, profile: 'production' }, expected, now).state, 'inspection-unavailable');
});
test('page retains session cleanup failures without leaking identities or arbitrary data', async () => {
  const report = await inspect({ report: { mcp: { state: 'accepted-read-only', sessionCleanup: 'not-confirmed' } } });
  const visible = visibleLedgerAuthorization({ ...report, account: 'SECRET' }, expected);
  assert.equal(visible.mcp.sessionCleanup, 'not-confirmed');
  assert.doesNotMatch(JSON.stringify(visible), /SECRET|originId|containerId|runtimeImage/);
});
