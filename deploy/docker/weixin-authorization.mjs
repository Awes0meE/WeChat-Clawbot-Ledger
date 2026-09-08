import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const errors = new Map([
  ['CLAWBOT_WEIXIN_AWAITING_POLL', 'awaiting-poll'], ['CLAWBOT_WEIXIN_LOGIN_REQUIRED', 'login-required'],
  ['CLAWBOT_WEIXIN_REAUTHORIZATION_REQUIRED', 'reauthorization-required'], ['CLAWBOT_WEIXIN_POLL_TIMEOUT', 'poll-timeout'],
  ['CLAWBOT_WEIXIN_TRANSPORT_UNAVAILABLE', 'transport-unavailable'], ['CLAWBOT_WEIXIN_RESPONSE_UNRECOGNIZED', 'response-unrecognized'],
  ['CLAWBOT_WEIXIN_API_UNAVAILABLE', 'api-unavailable'], ['CLAWBOT_WEIXIN_MESSAGE_PROCESSING_FAILED', 'message-processing-failed'],
]);
export function summarizeWeixinAuthorization(raw, accountId, now = Date.now()) {
  const report = state => ({ version: 1, state, remoteVerified: false, messageAcceptanceVerified: false,
    restartRecommended: false, observedAt: new Date(now).toISOString() });
  try {
    assert.ok(typeof accountId === 'string' && accountId.length > 0);
    if (raw?.configOnly === true || raw?.gatewayReachable === false) return report('gateway-unavailable');
    assert.ok(Number.isSafeInteger(raw?.ts) && raw.ts <= now && now - raw.ts < 30000);
    assert.ok(Array.isArray(raw.channelAccounts?.['openclaw-weixin']));
    const selected = raw.channelAccounts['openclaw-weixin'].filter(row => row?.accountId === accountId);
    assert.equal(selected.length, 1);
    const row = selected[0];
    assert.equal(typeof row.enabled, 'boolean'); assert.equal(typeof row.configured, 'boolean');
    if (!row.enabled) return report('runtime-disabled');
    if (!row.configured) return report('login-required');
    const state = errors.get(row.lastError);
    if (state) return report(state);
    if (row.running !== true) return report('not-running');
    if (row.lastError !== null || row.connected !== true) return report('unknown');
    assert.ok(Number.isSafeInteger(row.lastStartAt) && row.lastStartAt > 0 && row.lastStartAt <= raw.ts);
    assert.ok(Number.isSafeInteger(row.lastEventAt) && row.lastEventAt >= row.lastStartAt && row.lastEventAt <= raw.ts);
    // A reachable gateway can retain an old successful poll while processing
    // stalls. Publish that age explicitly instead of claiming current access.
    if (now - row.lastEventAt > 5 * 60000) return report('poll-stale');
    return { ...report('last-poll-accepted'), pollObservedAt: new Date(row.lastEventAt).toISOString() };
  } catch { return report('inspection-unavailable'); }
}

// The fixed official command requests channels.status with probe=false.
// It can return a config-only fallback; the projector above rejects that as
// live authorization evidence. Neither login nor another receiver is started.
export async function inspectConfiguredWeixin(config, { run = promisify(execFile), now = Date.now } = {}) {
  const unavailable = state => ({ version: 1, state, remoteVerified: false, messageAcceptanceVerified: false,
    restartRecommended: false, observedAt: new Date(now()).toISOString() });
  try {
    const profile = config?.plugins?.entries?.['clawbot-bookkeeping']?.config?.deploymentProfile;
    if (profile === 'isolated-test') {
      assert.ok(config.channels?.['openclaw-weixin']?.enabled !== true);
      return unavailable('not-enabled');
    }
    assert.equal(profile, 'production'); assert.equal(config.channels?.['openclaw-weixin']?.enabled, true);
    const routes = config.bindings?.filter(row => row.type === 'route' && row.agentId === 'bookkeeper' && row.match?.channel === 'openclaw-weixin');
    assert.equal(routes?.length, 1);
    for (const [path, hash] of [
      ['/app/dist/status-DSfPwB_2.js', 'd8374477c19a10f410ddc13b30bc7177730133627a85480ee92f1076e739bcde'],
      ['/app/dist/status-DUmf9DF4.js', 'be4780e04a6506072b4e46386e771bc42ff9407081a059c2755d01d399e194de'],
    ]) assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash);
    const { stdout } = await run(process.execPath, ['/app/openclaw.mjs', 'channels', 'status', '--channel', 'openclaw-weixin', '--json'],
      { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
    return summarizeWeixinAuthorization(JSON.parse(stdout), routes[0].match.accountId, now());
  } catch { return unavailable('inspection-unavailable'); }
}
