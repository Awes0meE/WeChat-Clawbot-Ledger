import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import plugin from '../index.ts';

function createPluginHarness(tempDirectory, fetchImpl) {
  const inboundHooks = new Map();
  let recordExpenseFactory;
  const pluginApi = {
    pluginConfig: {
      serverBaseUrl: 'http://127.0.0.1:8180',
      tokenPath: join(tempDirectory, 'token.txt'),
      stateDbPath: join(tempDirectory, 'receipts.sqlite'),
      accountName: '日常支出',
    },
    on(name, handler) {
      inboundHooks.set(name, handler);
    },
    registerTool(definition, options) {
      if (typeof definition === 'function' && options?.name === 'record_expense') {
        recordExpenseFactory = definition;
      }
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  plugin.register(pluginApi);

  return {
    inboundHooks,
    recordExpenseFactory,
    restore() {
      inboundHooks.get('gateway_stop')?.({}, {});
      globalThis.fetch = originalFetch;
    },
  };
}

function trustedOwnerContext() {
  return {
    senderIsOwner: true,
    sessionKey: 'agent:main:main',
    messageChannel: 'openclaw-weixin',
    agentAccountId: 'bot-account',
    requesterSenderId: 'owner-user',
  };
}

async function receiveTrustedOwnerMessage(inboundHooks) {
  await inboundHooks.get('message_received')({
    content: 'NTUC购物8.25，买了两根芹菜，一个菜板',
    timestamp: 1_788_425_460,
    messageId: 'wechat-message-3',
    senderId: 'owner-user',
    sessionKey: 'agent:main:main',
  }, {
    channelId: 'openclaw-weixin',
    accountId: 'bot-account',
    messageId: 'wechat-message-3',
    senderId: 'owner-user',
    sessionKey: 'agent:main:main',
  });
}

test('returns the authoritative rich receipt after a trusted expense write', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/accounts/list.json')) {
      return new Response(JSON.stringify({ success: true, result: [
        { id: 'account-1', name: '日常支出', currency: 'SGD' },
      ] }), { status: 200 });
    }
    if (url.endsWith('/transaction/categories/list.json')) {
      return new Response(JSON.stringify({ success: true, result: {
        2: [{ id: 'primary-1', name: '食品酒水', parentId: '0', subCategories: [
          { id: 'secondary-1', name: '超市购物', parentId: 'primary-1' },
        ] }],
      } }), { status: 200 });
    }
    if (url.endsWith('/transactions/add.json')) {
      return new Response(JSON.stringify({ success: true, result: { id: 'transaction-1' } }), { status: 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks);
    const tool = harness.recordExpenseFactory(trustedOwnerContext());
    const result = await tool.execute('tool-call-1', {
      amount: '8.25',
      primaryCategory: '食品酒水',
      subcategory: '超市购物',
      comment: '两根芹菜，一个菜板',
    });

    assert.equal(result.content[0].text, [
      '记下来啦！🧾',
      '账本：[ 日常账本 ]',
      '支出：8.25 SGD',
      '分类：食品酒水 - 超市购物',
      '备注：两根芹菜，一个菜板',
      '时间：2026/09/03 16:51',
    ].join('\n'));
    assert.equal(result.details.status, 'created');
    assert.equal(requests.length, 3);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('returns a stable failure receipt when ezBookkeeping cannot be reached', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  let requestCount = 0;
  const harness = createPluginHarness(tempDirectory, async () => {
    requestCount += 1;
    throw new Error('connection refused: sensitive failure details');
  });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks);
    const tool = harness.recordExpenseFactory(trustedOwnerContext());
    const result = await tool.execute('tool-call-2', {
      amount: '8.25',
      primaryCategory: '食品酒水',
      subcategory: '超市购物',
      comment: '两根芹菜，一个菜板',
    });

    assert.equal(result.content[0].text, '账本暂时连不上，本次没有写入任何数据，请稍后再试。');
    assert.deepEqual(result.details, { status: 'failed' });
    assert.equal(requestCount, 1);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
