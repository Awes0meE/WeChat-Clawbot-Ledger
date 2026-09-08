import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import plugin from '../index.ts';

test('durable execution and original after-tool hook share one reply authority', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-authority-'));
  const stateDbPath = join(directory, 'receipts.sqlite');
  function registry() {
    const hooks = new Map(), tools = new Map();
    plugin.register({ pluginConfig: { serverBaseUrl: 'http://127.0.0.1:8888', stateDbPath,
      accountName: '日常支出', tokenPath: join(directory, 'unused') },
    on: (name, handler) => hooks.set(name, handler),
    registerTool: (factory, options) => tools.set(options?.name ?? factory.name, factory),
    registerMcpServerConnectionResolver() {}, logger: { info() {}, error() {}, warn() {} } });
    return { hooks, tools };
  }
  const a = registry(), b = registry(), c = registry();
  try {
    const context = { runId: 'source-run', messageId: 'source-message', channelId: 'openclaw-weixin',
      accountId: 'test-bot', senderId: 'test-owner', sessionKey: 'agent:bookkeeper:test' };
    const content = '午饭7.2吗';
    await a.hooks.get('message_received')({ content, timestamp: Date.now(), ...context }, context);
    await a.hooks.get('before_agent_run')({ prompt: content, senderIsOwner: true, messages: [] }, context);
    const params = { amount: '7.2', currency: 'SGD', timeMode: 'received', primaryCategory: '食品酒水', subcategory: '早午晚餐' };
    const event = { runId: context.runId, toolCallId: 'source-call', toolName: 'prepare_expense', params };
    await a.hooks.get('before_tool_call')(event, { ...context, requester: { channel: 'openclaw-weixin',
      accountId: 'test-bot', senderId: 'test-owner', senderIsOwner: true } });
    const result = await b.tools.get('prepare_expense')({ senderIsOwner: true, messageChannel: 'openclaw-weixin',
      agentAccountId: 'test-bot', requesterSenderId: 'test-owner', sessionKey: context.sessionKey }).execute('bridge-call', params);
    assert.equal(result.details.status, 'pending_confirmation');
    await a.hooks.get('after_tool_call')({ ...event, result }, context);
    const db = new DatabaseSync(stateDbPath, { readOnly: true });
    try { assert.equal(db.prepare('SELECT count(*) AS count FROM pending_authoritative_replies').get().count, 1); }
    finally { db.close(); }
    const outgoing = await c.hooks.get('message_sending')({ to: 'test-owner', content: 'model paraphrase',
      metadata: { runId: 'delivery-run', channel: 'openclaw-weixin', accountId: 'test-bot' } }, { channelId: 'openclaw-weixin', accountId: 'test-bot' });
    assert.equal(outgoing?.content, result.content[0].text);
  } finally {
    for (const r of [a, b, c]) r.hooks.get('gateway_stop')?.({}, {});
    rmSync(directory, { recursive: true, force: true });
  }
});
