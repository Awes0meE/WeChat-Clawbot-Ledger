import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import plugin from '/opt/clawbot/plugins/clawbot-bookkeeping/index.ts';

const config = JSON.parse(readFileSync('/var/lib/clawbot-test/openclaw/openclaw.json'));
const owner = { senderIsOwner: true, sessionKey: 'agent:bookkeeper:p1', messageChannel: 'openclaw-weixin', agentAccountId: 'clawbot-test-account', requesterSenderId: 'clawbot-test-owner' };
function registry() {
  const hooks = new Map(), factories = new Map(); let resolver;
  plugin.register({ config, pluginConfig: config.plugins.entries['clawbot-bookkeeping'].config,
    on: (name, handler) => hooks.set(name, handler),
    registerTool: (factory, options) => factories.set(options?.name ?? factory.name, factory),
    registerMcpServerConnectionResolver: (value) => { resolver = value.resolve; },
    logger: { info() {}, warn() {}, error() {} },
  });
  return { hooks, factories, resolve: (...args) => resolver(...args), close: () => hooks.get('gateway_stop')?.({}, {}) };
}
const id = randomUUID();
const a = registry(), b = registry();
async function turn(content, suffix, toolName, params, execution = b) {
  const runId = `p1-${id}-${suffix}`, toolCallId = `${runId}-tool`;
  const context = { channelId: 'openclaw-weixin', accountId: 'clawbot-test-account', senderId: 'clawbot-test-owner', sessionKey: owner.sessionKey, messageId: runId, runId };
  await a.hooks.get('message_received')({ ...context, content, timestamp: Date.now() }, context);
  await a.hooks.get('before_agent_run')({ prompt: content, messages: [], senderIsOwner: true }, context);
  const binding = await a.hooks.get('before_tool_call')({ toolName, params, runId, toolCallId }, { ...context, requester: { channel: 'openclaw-weixin', accountId: context.accountId, senderId: context.senderId, senderIsOwner: true } });
  assert.notEqual(binding?.block, true);
  const factory = execution.factories.get(toolName);
  const result = await (typeof factory === 'function' ? factory(owner).execute(toolCallId, binding?.params ?? params) : factory.execute(toolCallId, params));
  await a.hooks.get('after_tool_call')?.({ toolName, params: binding?.params ?? params, result, runId, toolCallId }, context);
  return result;
}
const expense = { amount: '0.02', currency: 'SGD', timeMode: 'received', primaryCategory: '食品酒水', subcategory: '早午晚餐' };
try {
  const registered = [...b.factories.keys()].sort();
  assert.deepEqual(registered, ['bookkeeping_health', 'ezbookkeeping__query_transactions', 'find_expenses', 'prepare_expense', 'record_expense', 'resolve_expense_confirmation', 'summarize_expenses']);
  assert.equal(b.factories.get('ezbookkeeping__query_transactions')({ ...owner, requesterSenderId: 'stranger' }), null);
  const result = await turn('午饭0.02，备注P1跨实例验收', 'record', 'record_expense', expense);
  assert.equal(result.details.status, 'created');
  assert.match(result.content[0].text, /记下来啦/);
  assert.equal(result.content[0].text.split('\n').length, 6);
  const proposal = await turn('午饭0.03吗', 'prepare', 'prepare_expense', { ...expense, amount: '0.03' });
  assert.equal(proposal.details.status, 'pending_confirmation');
  // Fresh registry must recover the pending proposal from persistent SQLite.
  const c = registry();
  try { assert.equal((await turn('是', 'confirm', 'resolve_expense_confirmation', { decision: 'confirm' }, c)).details.status, 'created'); }
  finally { c.close(); }
  await assert.rejects(b.factories.get('record_expense')({ ...owner, senderIsOwner: false, requesterSenderId: 'stranger' }).execute('untrusted-tool', expense));
  const history = await turn('查询最近三笔支出', 'history', 'ezbookkeeping__query_transactions', {
    start_time: '1970-01-01T00:00:00Z', end_time: new Date().toISOString(), count: 3,
  });
  assert.notEqual(history.isError, true);
  assert.match(history.content[0].text, /支出明细/);
  assert.equal(history.details.structuredContent.transactions.length, 3);
  console.log('CLAWBOT_REGISTERED_PLUGIN_CROSS_INSTANCE_CONFIRMATION_AND_OWNER_OK');
} finally { a.close(); b.close(); }
