import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolveDeploymentProfile } from '/opt/clawbot/plugins/clawbot-bookkeeping/deployment-profile.mjs';
import { trustedInboundMessageKey } from '/opt/clawbot/plugins/clawbot-bookkeeping/adapter.mjs';
import { dispatchReplyWithDispatcher } from '/app/dist/plugin-sdk/reply-runtime.js';
import { initializeGlobalHookRunner, resetGlobalHookRunner } from '/app/dist/plugin-sdk/hook-runtime.js';
import { disposeRegisteredAgentHarnesses } from '/app/dist/plugin-sdk/agent-harness.js';
import { t as loadRegistry } from '/app/dist/runtime-plugins-CfPqEvbY.js';
import { k as setActiveRegistry } from '/app/dist/runtime-qPjwNjo-.js';
import { applyWeixinMessageSendingHook } from '/opt/clawbot/plugins/openclaw-weixin-stable-id/dist/src/messaging/outbound-hooks.js';

const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH));
const pluginConfig = config.plugins.entries['clawbot-bookkeeping'].config;
resolveDeploymentProfile(pluginConfig, config);
const registry = loadRegistry({ config, basePluginIds: config.plugins.allow, workspaceDir: '/opt/clawbot/workspace' });
for (const name of ['before_agent_run', 'before_prompt_build', 'llm_input', 'agent_end']) {
  assert.ok(registry.typedHooks.some((h) => h.pluginId === 'clawbot-bookkeeping' && h.hookName === name), `Missing ${name}`);
}
setActiveRegistry(registry, 'clawbot-p1-channel-probe', 'default', '/opt/clawbot/workspace');
initializeGlobalHookRunner(registry);
const sessionKey = `agent:bookkeeper:openclaw-weixin:clawbot-test-account:direct:p1-${randomUUID()}`;
const started = Date.now();
const cases = process.argv.includes('--suite') ? [
  { name: 'record', body: '午饭0.04，备注P1模型验收', pattern: /记下来啦/ },
  { name: 'prepare', body: '午饭0.05吗', pattern: /确认/ },
  { name: 'confirm', body: '是', pattern: /记下来啦/ },
  { name: 'prepare-cancel', body: '午饭0.06吗', pattern: /确认/ },
  { name: 'cancel', body: '取消', pattern: /取消|没记|不记/ },
  { name: 'summary', body: '今天一共花了多少钱？', pattern: /今天|今日/ },
  { name: 'find', body: '查一下今天单笔金额等于0.04新币的支出', pattern: /0\.04/ },
] : [];
cases.push({ name: 'history', body: '请用历史明细查询工具，查从1970年1月1日到现在的最近三笔支出。', pattern: /支出明细/ });
try {
 for (const { name, body, pattern } of cases) {
  const messageId = randomUUID();
  const deliveries = [];
  await dispatchReplyWithDispatcher({ config, cfg: config, ctx: {
    Body: body, RawBody: body, CommandBody: body,
    From: 'clawbot-test-owner', To: 'clawbot-test-owner', SenderId: 'clawbot-test-owner',
    Provider: 'openclaw-weixin', Surface: 'openclaw-weixin', OriginatingChannel: 'openclaw-weixin',
    OriginatingTo: 'clawbot-test-owner', AccountId: 'clawbot-test-account', ChatType: 'direct',
    MessageSid: messageId, Timestamp: Date.now(), CommandAuthorized: true,
    SessionKey: sessionKey,
  }, dispatcherOptions: {
    deliver: async (payload, info) => {
      if (info.kind !== 'final') return;
      // Match the channel's outbound bridge; no WeChat send function is called.
      // A channel-local run ID recovers authority across runtime instances.
      const sending = await applyWeixinMessageSendingHook({ to: 'clawbot-test-owner',
        accountId: 'clawbot-test-account', runId: `p1-delivery-${messageId}`, text: payload.text ?? '' });
      assert.equal(sending.cancelled, false);
      deliveries.push(sending.text);
    },
    onError: () => { throw new Error('Synthetic delivery failed'); },
  }, replyOptions: { disableBlockStreaming: true } });
  const db = new DatabaseSync(pluginConfig.stateDbPath, { readOnly: true });
  try {
    const saved = db.prepare('SELECT text FROM pending_authoritative_replies WHERE source_message_key = ?')
      .all(trustedInboundMessageKey('openclaw-weixin', messageId));
    console.log(JSON.stringify({ case: name, finalDeliveries: deliveries.length, authoritativeReplies: saved.length,
      expectedReply: deliveries.some((text) => pattern.test(text)) }));
    assert.equal(saved.length, 1, 'Expected current-message authoritative reply');
    assert.equal(deliveries.length, 1);
    assert.ok(deliveries[0] === saved[0].text, 'Reply must equal persisted validated history');
    assert.ok(pattern.test(deliveries[0]), `Unexpected authoritative reply for ${name}`);
    if (name === 'history') assert.equal(deliveries[0].split('\n').filter((line) => /^\d+\./.test(line)).length, 3);
  } finally { db.close(); }
 }
 if (process.argv.includes('--suite')) {
  const db = new DatabaseSync('/var/lib/clawbot-test/openclaw/agents/bookkeeper/agent/codex-home/thread_history_1.sqlite', { readOnly: true });
  try {
    const called = new Set(db.prepare('SELECT item_json FROM thread_items WHERE item_type = ? AND created_at_ms >= ?')
      .all('dynamicToolCall', started).map((row) => JSON.parse(row.item_json))
      .filter((item) => item.success === true).map((item) => item.tool));
    assert.deepEqual([...called].sort(), [...config.agents.entries.bookkeeper.tools.allow].sort());
    console.log(JSON.stringify({ successfullyExecutedBusinessTools: [...called].sort() }));
  } finally { db.close(); }
 }
  console.log('CLAWBOT_SYNTHETIC_CHANNEL_MODEL_AUTHORITY_OK');
} finally {
  await disposeRegisteredAgentHarnesses();
  for (const hook of registry.typedHooks.filter((h) => h.hookName === 'gateway_stop')) await hook.handler({}, {});
  resetGlobalHookRunner();
}
// This one-shot CLI never starts a receiver. SDK housekeeping timers can keep
// the process alive after the completed/awaited test; terminate the CLI cleanly.
process.exit(0);
