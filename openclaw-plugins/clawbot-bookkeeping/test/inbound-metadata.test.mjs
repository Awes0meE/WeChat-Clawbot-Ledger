import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import plugin from '../index.ts';
import { SqliteReceiptStore } from '../adapter.mjs';

test('correlates trusted metadata across isolated plugin instances', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  const stateDbPath = join(tempDirectory, 'receipts.sqlite');
  const receiptKey = 'openclaw-weixin:wechat-message-2';
  const seedStore = new SqliteReceiptStore(stateDbPath);
  assert.equal(seedStore.claim(receiptKey), null);
  seedStore.complete(receiptKey, {
    status: 'created',
    transactionId: 'transaction-existing',
  });
  seedStore.close();

  const inboundHooks = new Map();
  const toolHooks = new Map();
  let recordExpenseFactory;
  const pluginConfig = {
    serverBaseUrl: 'http://127.0.0.1:8180',
    tokenPath: join(tempDirectory, 'unused-token.txt'),
    stateDbPath,
    accountName: '日常支出',
  };
  const inboundApi = {
    pluginConfig,
    on(name, handler) {
      inboundHooks.set(name, handler);
    },
    registerTool() {},
    registerMcpServerConnectionResolver() {},
  };
  const toolApi = {
    pluginConfig,
    on(name, handler) {
      toolHooks.set(name, handler);
    },
    registerTool(definition, options) {
      if (typeof definition === 'function' && options?.name === 'record_expense') {
        recordExpenseFactory = definition;
      }
    },
    registerMcpServerConnectionResolver() {},
  };

  try {
    plugin.register(inboundApi);
    plugin.register(toolApi);
    assert.equal(typeof inboundHooks.get('message_received'), 'function');
    assert.equal(typeof recordExpenseFactory, 'function');

    await inboundHooks.get('message_received')({
      content: '午饭12.5',
      timestamp: 1_788_383_892_456,
      messageId: 'wechat-message-2',
      senderId: 'owner-user',
      sessionKey: 'agent:main:main',
      runId: 'run-cross-instance',
    }, {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
      messageId: 'wechat-message-2',
      senderId: 'owner-user',
      sessionKey: 'agent:main:main',
      runId: 'run-cross-instance',
    });

    await toolHooks.get('before_agent_run')({
      prompt: '午饭12.5',
      messages: [],
      senderIsOwner: true,
    }, {
      channel: 'openclaw-weixin',
      accountId: 'bot-account',
      senderId: 'owner-user',
      sessionKey: 'agent:main:main',
      runId: 'run-cross-instance',
    });

    const tool = recordExpenseFactory({
      senderIsOwner: true,
      sessionKey: 'agent:main:main',
      messageChannel: 'openclaw-weixin',
      agentAccountId: 'bot-account',
      requesterSenderId: 'owner-user',
    });
    await toolHooks.get('before_tool_call')({
      toolName: 'record_expense',
      params: {
        amount: '12.5',
        currency: 'SGD',
        timeMode: 'received',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
      },
      runId: 'run-cross-instance',
      toolCallId: 'tool-call-1',
    }, {
      toolName: 'record_expense',
      runId: 'run-cross-instance',
      toolCallId: 'tool-call-1',
      requester: { senderId: 'owner-user', senderIsOwner: true },
    });
    const result = await tool.execute('tool-call-1', {
      amount: '12.5',
      currency: 'SGD',
      timeMode: 'received',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
    });

    assert.equal(result.details.status, 'duplicate');
    assert.equal(result.details.previousStatus, 'created');
  } finally {
    inboundHooks.get('gateway_stop')?.({}, {});
    toolHooks.get('gateway_stop')?.({}, {});
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
