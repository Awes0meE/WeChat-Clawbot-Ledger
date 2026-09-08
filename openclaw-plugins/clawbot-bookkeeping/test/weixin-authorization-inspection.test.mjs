import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWeixinAuthorization, inspectConfiguredWeixin } from '../../../deploy/docker/weixin-authorization.mjs';
import { inspectWeixinAuthorization, visibleWeixinAuthorization } from '../../../scripts/mac/weixin-authorization-inspection.mjs';
const now = Date.parse('2026-09-08T12:00:00Z'), accountId = 'synthetic-selected';
const row = { accountId, enabled: true, configured: true, running: true, connected: true, lastError: null,
  lastStartAt: now - 600000, lastEventAt: now - 1000, token: 'SECRET', userId: 'PRIVATE' };
const payload = (account = row) => ({ ts: now, channelAccounts: { 'openclaw-weixin': [account] } });
test('only the selected account and a recent explicit successful poll yield accepted history', () => {
  const result = summarizeWeixinAuthorization(payload(), accountId, now);
  assert.equal(result.state, 'last-poll-accepted'); assert.equal(result.remoteVerified, false);
  assert.equal(result.messageAcceptanceVerified, false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE|synthetic-selected/);
  const mixed = payload(); mixed.channelAccounts['openclaw-weixin'].push({ ...row, accountId: 'another', lastError: 'CLAWBOT_WEIXIN_REAUTHORIZATION_REQUIRED' });
  assert.equal(summarizeWeixinAuthorization(mixed, accountId, now).state, 'last-poll-accepted');
});
test('config fallback, stale snapshots, missing and duplicate selected accounts never imply acceptance', () => {
  assert.equal(summarizeWeixinAuthorization({ configOnly: true, configuredChannels: ['openclaw-weixin'] }, accountId, now).state, 'gateway-unavailable');
  for (const raw of [{ ...payload(), ts: now - 30000 }, { ...payload(), ts: now + 1 }, payload({ ...row, accountId: 'another' }),
    { ...payload(), channelAccounts: { 'openclaw-weixin': [row, row] } }]) {
    assert.equal(summarizeWeixinAuthorization(raw, accountId, now).state, 'inspection-unavailable');
  }
  assert.equal(summarizeWeixinAuthorization(payload({ ...row, lastEventAt: now - 300001 }), accountId, now).state, 'poll-stale');
  assert.equal(summarizeWeixinAuthorization(payload({ ...row, lastEventAt: now + 1 }), accountId, now).state, 'inspection-unavailable');
});
test('explicit authentication failures stay distinct from network, timeout and processing failures', () => {
  const pairs = [['REAUTHORIZATION_REQUIRED', 'reauthorization-required'], ['POLL_TIMEOUT', 'poll-timeout'],
    ['TRANSPORT_UNAVAILABLE', 'transport-unavailable'], ['MESSAGE_PROCESSING_FAILED', 'message-processing-failed'],
    ['AWAITING_POLL', 'awaiting-poll']];
  for (const [marker, state] of pairs) assert.equal(summarizeWeixinAuthorization(payload({ ...row, connected: false,
    lastError: 'CLAWBOT_WEIXIN_' + marker }), accountId, now).state, state);
  assert.equal(summarizeWeixinAuthorization(payload({ ...row, lastError: 'arbitrary SECRET' }), accountId, now).state, 'unknown');
  assert.equal(summarizeWeixinAuthorization(payload({ ...row, configured: false }), accountId, now).state, 'login-required');
  assert.equal(summarizeWeixinAuthorization(payload({ ...row, running: false }), accountId, now).state, 'not-running');
});
test('isolated environment does not request a login or a gateway/Tencent probe', async () => {
  const config = { plugins: { entries: { 'clawbot-bookkeeping': { config: { deploymentProfile: 'isolated-test' } } } }, channels: {} };
  const options = { run: () => { throw Error('Must not invoke a command'); }, now: () => now };
  assert.equal((await inspectConfiguredWeixin(config, options)).state, 'not-enabled');
  config.channels['openclaw-weixin'] = { enabled: true };
  assert.equal((await inspectConfiguredWeixin(config, options)).state, 'inspection-unavailable');
});
const sourceCommit = 'a'.repeat(40), id = 'b'.repeat(64), image = `sha256:${'c'.repeat(64)}`, startedAt = '2026-09-08T00:00:00Z';
function harness(option = {}) {
  let inspection = 0, identities = 0;
  return { inspect: async () => ++inspection > 1 && option.replaced ? 'd'.repeat(64) : id,
    run: async (args, input) => {
      if (args[0] === 'inspect') return JSON.stringify({ id, image, startedAt: ++identities > 1 && option.restarted ? '2026-09-08T00:01:00Z' : startedAt, running: true });
      assert.deepEqual(args, ['exec', '-i', id, 'node', '--input-type=module', '-']);
      assert.match(input, /inspectConfiguredWeixin\(config\)/);
      return JSON.stringify({ version: 1, state: 'not-enabled', observedAt: new Date().toISOString(), remoteVerified: false,
        messageAcceptanceVerified: false, restartRecommended: false, token: 'SECRET', ...option.report });
    } };
}
test('host inspection strips raw metadata and rechecks the exact container after reading', async () => {
  const report = await inspectWeixinAuthorization({ ...harness(), profile: 'isolated-test', sourceCommit });
  assert.equal(report.state, 'not-enabled'); assert.equal(report.containerId, id);
  assert.doesNotMatch(JSON.stringify(report), /SECRET/);
  for (const option of [{ replaced: true }, { restarted: true }, { report: { remoteVerified: true } }, { report: { state: 'SECRET' } }]) {
    await assert.rejects(inspectWeixinAuthorization({ ...harness(option), profile: 'isolated-test', sourceCommit }));
  }
});
test('test dashboard expires identity-bound results and never presents a real receiver as accepted', async () => {
  const report = await inspectWeixinAuthorization({ ...harness(), profile: 'isolated-test', sourceCommit });
  const expected = { sourceCommit, runtimeImage: image, containerId: id, containerStartedAt: startedAt }, time = Date.parse(report.observedAt);
  assert.equal(visibleWeixinAuthorization(report, expected, time).state, 'not-enabled');
  assert.equal(visibleWeixinAuthorization(report, expected, time + 360001).state, 'stale');
  for (const key of Object.keys(expected)) assert.equal(visibleWeixinAuthorization(report, { ...expected, [key]: 'changed' }, time).state, 'inspection-unavailable');
  assert.equal(visibleWeixinAuthorization(report, expected, time - 1).state, 'inspection-unavailable');
  assert.equal(visibleWeixinAuthorization({ ...report, state: 'last-poll-accepted' }, expected, time).state, 'inspection-unavailable');
  assert.doesNotMatch(JSON.stringify(visibleWeixinAuthorization(report, expected, time)), /containerId|runtimeImage|sourceCommit/);
});
