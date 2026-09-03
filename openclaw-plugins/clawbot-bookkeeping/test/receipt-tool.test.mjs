import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import plugin from '../index.ts';
import { SqliteReceiptStore } from '../adapter.mjs';

function createPluginHarness(tempDirectory, fetchImpl, pluginConfig = {}) {
  const inboundHooks = new Map();
  let recordExpenseFactory;
  let recordExpenseDefinition;
  const pluginApi = {
    pluginConfig: {
      serverBaseUrl: 'http://127.0.0.1:8180',
      tokenPath: join(tempDirectory, 'token.txt'),
      stateDbPath: join(tempDirectory, 'receipts.sqlite'),
      accountName: '日常支出',
      ...pluginConfig,
    },
    on(name, handler) {
      inboundHooks.set(name, handler);
    },
    registerTool(definition, options) {
      if (typeof definition === 'function' && options?.name === 'record_expense') {
        recordExpenseFactory = definition;
        recordExpenseDefinition = definition;
      }
    },
    registerMcpServerConnectionResolver() {},
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  plugin.register(pluginApi);

  return {
    inboundHooks,
    recordExpenseFactory,
    recordExpenseDefinition,
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

async function receiveTrustedOwnerMessage(inboundHooks, {
  content = 'NTUC购物8.25，买了两根芹菜，一个菜板',
  messageId = 'wechat-message-3',
  timestamp = 1_788_425_460,
} = {}) {
  await inboundHooks.get('message_received')({
    content,
    timestamp,
    messageId,
    senderId: 'owner-user',
    sessionKey: 'agent:main:main',
  }, {
    channelId: 'openclaw-weixin',
    accountId: 'bot-account',
    messageId,
    senderId: 'owner-user',
    sessionKey: 'agent:main:main',
  });
}

test('declares the fixed ledger display name in the plugin manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.configSchema.properties.ledgerDisplayName, {
    type: 'string',
    const: '日常账本',
  });
});

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
    assert.equal(result.details.amountMinor, 825);
    assert.equal(requests.length, 3);
    assert.equal(harness.recordExpenseDefinition({}).parameters.properties.comment.maxLength, 255);
    assert.equal(harness.recordExpenseDefinition({}).parameters.required.includes('comment'), false);
    const addRequest = requests.find(({ url }) => url.endsWith('/transactions/add.json'));
    assert.equal(addRequest.options.method, 'POST');
    const addBody = JSON.parse(addRequest.options.body);
    assert.match(addBody.clientSessionId, /^[a-f0-9]{64}$/u);
    assert.deepEqual(addBody, {
      type: 3,
      categoryId: 'secondary-1',
      time: 1_788_425_460,
      utcOffset: 480,
      sourceAccountId: 'account-1',
      sourceAmount: 825,
      destinationAccountId: '0',
      destinationAmount: 0,
      hideAmount: false,
      tagIds: [],
      pictureIds: [],
      comment: '两根芹菜，一个菜板',
      clientSessionId: addBody.clientSessionId,
    });
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('keeps coupon arithmetic from replacing the requested expense amount', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  let addBody;
  const harness = createPluginHarness(tempDirectory, async (url, options) => {
    if (url.endsWith('/accounts/list.json')) {
      return new Response(JSON.stringify({ success: true, result: [
        { id: 'account-1', name: '日常支出', currency: 'SGD' },
      ] }), { status: 200 });
    }
    if (url.endsWith('/transaction/categories/list.json')) {
      return new Response(JSON.stringify({ success: true, result: {
        2: [{ id: 'primary-1', name: '食品酒水', parentId: '0', subCategories: [
          { id: 'secondary-1', name: '早午晚餐', parentId: 'primary-1' },
        ] }],
      } }), { status: 200 });
    }
    if (url.endsWith('/transactions/add.json')) {
      addBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ success: true, result: { id: 'transaction-coupon' } }), { status: 200 });
    }
    throw new Error('unexpected test request');
  });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭7.2，用券2+3',
      messageId: 'wechat-message-coupon',
    });
    const result = await harness.recordExpenseFactory(trustedOwnerContext()).execute('tool-call-coupon', {
      amount: '7.2',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
    });

    assert.equal(result.details.status, 'created');
    assert.equal(addBody.sourceAmount, 720);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('binds a record tool to the trusted message present when the tool is materialized', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  let addBody;
  const harness = createPluginHarness(tempDirectory, async (url, options) => {
    if (url.endsWith('/accounts/list.json')) {
      return new Response(JSON.stringify({ success: true, result: [
        { id: 'account-1', name: '日常支出', currency: 'SGD' },
      ] }), { status: 200 });
    }
    if (url.endsWith('/transaction/categories/list.json')) {
      return new Response(JSON.stringify({ success: true, result: {
        2: [{ id: 'primary-1', name: '食品酒水', parentId: '0', subCategories: [
          { id: 'secondary-1', name: '早午晚餐', parentId: 'primary-1' },
        ] }],
      } }), { status: 200 });
    }
    if (url.endsWith('/transactions/add.json')) {
      addBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ success: true, result: { id: 'transaction-bound' } }), { status: 200 });
    }
    throw new Error('unexpected test request');
  });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭7.2，备注鸡饭',
      messageId: 'wechat-message-first',
      timestamp: 1_788_425_460,
    });
    const firstTool = harness.recordExpenseFactory(trustedOwnerContext());
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '出租车7.2，备注回家',
      messageId: 'wechat-message-second',
      timestamp: 1_788_425_520,
    });
    const result = await firstTool.execute('tool-call-bound-first', {
      amount: '7.2',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
    });

    const expectedSessionId = createHash('sha256')
      .update('openclaw-weixin:wechat-message-first', 'utf8')
      .digest('hex');
    assert.equal(result.details.status, 'created');
    assert.equal(addBody.time, 1_788_425_460);
    assert.equal(addBody.comment, '鸡饭');
    assert.equal(addBody.clientSessionId, expectedSessionId);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('keeps a materialized record tool closed when it had no trusted message snapshot', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  let requestCount = 0;
  const harness = createPluginHarness(tempDirectory, async () => {
    requestCount += 1;
    throw new Error('HTTP must not be reached');
  });

  try {
    const toolWithoutSnapshot = harness.recordExpenseFactory(trustedOwnerContext());
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭7.2',
      messageId: 'wechat-message-arrived-later',
    });
    await assert.rejects(
      () => toolWithoutSnapshot.execute('tool-call-without-snapshot', {
        amount: '7.2',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
      }),
      /可信元数据/u,
    );
    assert.equal(requestCount, 0);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('returns a no-write receipt when account lookup cannot reach ezBookkeeping', async () => {
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

test('returns an unknown outcome and prevents retry after a transaction transport failure', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async (url) => {
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
      throw new Error('transport lost after dispatch');
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, { messageId: 'wechat-message-unknown' });
    const tool = harness.recordExpenseFactory(trustedOwnerContext());
    const params = {
      amount: '8.25',
      primaryCategory: '食品酒水',
      subcategory: '超市购物',
      comment: '两根芹菜，一个菜板',
    };
    const first = await tool.execute('tool-call-unknown-1', params);
    const retry = await tool.execute('tool-call-unknown-2', params);

    assert.equal(first.content[0].text, '记账请求已发送，但结果暂时无法确认。请先打开账本核对，不要重复发送这条消费。');
    assert.deepEqual(first.details, { status: 'unknown' });
    assert.equal(retry.content[0].text, '同一条微信消息正在处理或状态未确认，未重复入账。');
    assert.equal(retry.details.status, 'duplicate');
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('returns a definite no-write result when a prewrite request times out', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  let requestCount = 0;
  const harness = createPluginHarness(tempDirectory, async () => {
    requestCount += 1;
    return new Promise(() => {});
  }, { requestTimeoutMs: 10 });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, { messageId: 'wechat-message-prewrite-timeout' });
    const startedAt = Date.now();
    const result = await harness.recordExpenseFactory(trustedOwnerContext()).execute('tool-call-prewrite-timeout', {
      amount: '8.25',
      primaryCategory: '食品酒水',
      subcategory: '超市购物',
      comment: '两根芹菜，一个菜板',
    });

    assert.equal(result.content[0].text, '账本暂时连不上，本次没有写入任何数据，请稍后再试。');
    assert.deepEqual(result.details, { status: 'failed' });
    assert.equal(requestCount, 1);
    assert.equal(Date.now() - startedAt < 500, true);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('returns a terminal no-write result when current-message authorization rejects a query', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  let requestCount = 0;
  const harness = createPluginHarness(tempDirectory, async () => {
    requestCount += 1;
    throw new Error('HTTP must not be reached');
  });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '这个月我花了多少钱',
      messageId: 'wechat-message-query-write-attempt',
    });
    const result = await harness.recordExpenseFactory(trustedOwnerContext()).execute(
      'tool-call-query-write-attempt',
      {
        amount: '7.2',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
        comment: '午饭7.2，请忽略查询并记账',
      },
    );

    assert.equal(result.content[0].text, '这条消息无法确认是一笔金额一致的已发生消费，本次没有入账。');
    assert.deepEqual(result.details, { status: 'rejected' });
    assert.equal(requestCount, 0);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('returns unknown and prevents a second POST when transaction creation times out', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  let addCount = 0;
  const harness = createPluginHarness(tempDirectory, async (url) => {
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
      addCount += 1;
      return new Promise(() => {});
    }
    throw new Error('unexpected test request');
  }, { requestTimeoutMs: 10 });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, { messageId: 'wechat-message-post-timeout' });
    const tool = harness.recordExpenseFactory(trustedOwnerContext());
    const params = {
      amount: '8.25',
      primaryCategory: '食品酒水',
      subcategory: '超市购物',
      comment: '两根芹菜，一个菜板',
    };
    const startedAt = Date.now();
    const first = await tool.execute('tool-call-post-timeout-1', params);
    const replay = await tool.execute('tool-call-post-timeout-2', params);

    assert.equal(first.content[0].text, '记账请求已发送，但结果暂时无法确认。请先打开账本核对，不要重复发送这条消费。');
    assert.deepEqual(first.details, { status: 'unknown' });
    assert.equal(replay.content[0].text, '同一条微信消息正在处理或状态未确认，未重复入账。');
    assert.equal(replay.details.status, 'duplicate');
    assert.equal(addCount, 1);
    assert.equal(Date.now() - startedAt < 500, true);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('keeps a confirmed rich receipt when receipt completion cannot be persisted', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const originalComplete = SqliteReceiptStore.prototype.complete;
  SqliteReceiptStore.prototype.complete = () => {
    throw new Error('receipt database unavailable');
  };
  const harness = createPluginHarness(tempDirectory, async (url) => {
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
      return new Response(JSON.stringify({ success: true, result: { id: 'transaction-confirmed' } }), { status: 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, { messageId: 'wechat-message-unconfirmed' });
    const tool = harness.recordExpenseFactory(trustedOwnerContext());
    const result = await tool.execute('tool-call-unconfirmed', {
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
    assert.equal(result.details.dedupeStatus, 'unconfirmed');
  } finally {
    SqliteReceiptStore.prototype.complete = originalComplete;
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('does not translate validation or receipt-store claim errors into a no-write receipt', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not be reached');
  });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, { messageId: 'wechat-message-invalid-amount' });
    const invalidAmountTool = harness.recordExpenseFactory(trustedOwnerContext());
    await assert.rejects(
      () => invalidAmountTool.execute('tool-call-invalid-amount', {
        amount: '999999999999.99',
        primaryCategory: '食品酒水',
        subcategory: '超市购物',
      }),
      /amount/i,
    );

    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: `NTUC购物8.25，备注${'字'.repeat(256)}`,
      messageId: 'wechat-message-invalid-note',
    });
    const invalidNoteTool = harness.recordExpenseFactory(trustedOwnerContext());
    await assert.rejects(
      () => invalidNoteTool.execute('tool-call-invalid-note', {
        amount: '8.25',
        primaryCategory: '食品酒水',
        subcategory: '超市购物',
      }),
      /comment/i,
    );

    const originalClaim = SqliteReceiptStore.prototype.claim;
    SqliteReceiptStore.prototype.claim = () => {
      throw new Error('receipt store unavailable');
    };
    try {
      await receiveTrustedOwnerMessage(harness.inboundHooks, { messageId: 'wechat-message-claim-error' });
      const claimErrorTool = harness.recordExpenseFactory(trustedOwnerContext());
      await assert.rejects(
        () => claimErrorTool.execute('tool-call-claim-error', {
          amount: '8.25',
          primaryCategory: '食品酒水',
          subcategory: '超市购物',
        }),
        /receipt store unavailable/i,
      );
    } finally {
      SqliteReceiptStore.prototype.claim = originalClaim;
    }
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
