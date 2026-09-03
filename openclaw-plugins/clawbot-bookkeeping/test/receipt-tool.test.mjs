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
  let prepareExpenseFactory;
  let resolveExpenseConfirmationFactory;
  let recordExpenseDefinition;
  const logs = [];
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
      if (typeof definition === 'function' && options?.name === 'prepare_expense') {
        prepareExpenseFactory = definition;
      }
      if (typeof definition === 'function' && options?.name === 'resolve_expense_confirmation') {
        resolveExpenseConfirmationFactory = definition;
      }
    },
    registerMcpServerConnectionResolver() {},
    logger: {
      error(message) { logs.push(message); },
      warn(message) { logs.push(message); },
      info() {},
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  plugin.register(pluginApi);

  const materializeExpenseTool = (factory, toolName, toolContext) => {
    const tool = factory(toolContext);
    return {
      ...tool,
      async execute(toolCallId, params) {
        return executeForTurn(inboundHooks, tool, {
          runId: inboundHooks.latestRunId,
          toolCallId,
          toolName,
          params,
        });
      },
    };
  };

  return {
    inboundHooks,
    recordExpenseFactory: (context) => materializeExpenseTool(recordExpenseFactory, 'record_expense', context),
    prepareExpenseFactory: (context) => materializeExpenseTool(prepareExpenseFactory, 'prepare_expense', context),
    resolveExpenseConfirmationFactory: (context) => materializeExpenseTool(
      resolveExpenseConfirmationFactory,
      'resolve_expense_confirmation',
      context,
    ),
    rawRecordExpenseFactory: recordExpenseFactory,
    recordExpenseDefinition,
    logs,
    restore() {
      inboundHooks.get('gateway_stop')?.({}, {});
      globalThis.fetch = originalFetch;
    },
  };
}

async function beginTrustedOwnerTurn(inboundHooks, {
  content,
  messageId,
  runId,
  timestamp = 1_788_425_460,
}) {
  const messageContext = {
    channelId: 'openclaw-weixin',
    accountId: 'bot-account',
    messageId,
    senderId: 'owner-user',
    sessionKey: 'agent:main:main',
    runId,
  };
  await inboundHooks.get('message_received')({
    content,
    timestamp,
    messageId,
    senderId: 'owner-user',
    sessionKey: 'agent:main:main',
    runId,
  }, messageContext);
  await inboundHooks.get('before_agent_run')?.({
    prompt: content,
    messages: [],
    senderIsOwner: true,
  }, messageContext);
}

async function executeForTurn(inboundHooks, tool, {
  runId,
  toolCallId,
  toolName = 'record_expense',
  params,
}) {
  await bindToolCallForTurn(inboundHooks, { runId, toolCallId, toolName, params });
  return tool.execute(toolCallId, params);
}

async function bindToolCallForTurn(inboundHooks, {
  runId,
  toolCallId,
  toolName = 'record_expense',
  params,
}) {
  await inboundHooks.get('before_tool_call')?.({
    toolName,
    params,
    runId,
    toolCallId,
  }, {
    runId,
    toolCallId,
    sessionKey: 'agent:main:main',
    requester: {
      senderId: 'owner-user',
      senderIsOwner: true,
    },
  });
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

function successfulExpenseFetch(requests) {
  return async (url, options) => {
    requests.push({ url, options });
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
      return new Response(JSON.stringify({ success: true, result: { id: 'transaction-collision-test' } }), { status: 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
}

async function receiveTrustedOwnerMessage(inboundHooks, {
  content = 'NTUC购物8.25，买了两根芹菜，一个菜板',
  messageId = 'wechat-message-3',
  timestamp = 1_788_425_460,
} = {}) {
  const runId = `run-${messageId}-${++receiveTrustedOwnerMessage.sequence}`;
  inboundHooks.latestRunId = runId;
  const messageContext = {
    channelId: 'openclaw-weixin',
    accountId: 'bot-account',
    messageId,
    senderId: 'owner-user',
    sessionKey: 'agent:main:main',
    runId,
  };
  await inboundHooks.get('message_received')({
    content,
    timestamp,
    messageId,
    senderId: 'owner-user',
    sessionKey: 'agent:main:main',
    runId,
  }, messageContext);
  await inboundHooks.get('before_agent_run')?.({
    prompt: content,
    messages: [],
    senderIsOwner: true,
  }, messageContext);
  return runId;
}
receiveTrustedOwnerMessage.sequence = 0;

test('declares the fixed ledger display name in the plugin manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.configSchema.properties.ledgerDisplayName, {
    type: 'string',
    const: '日常账本',
  });
});

test('binds a trusted owner run when the embedded before-tool hook omits requester', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));

  try {
    await beginTrustedOwnerTurn(harness.inboundHooks, {
      content: '午饭7.2',
      messageId: 'embedded-hook-message',
      runId: 'embedded-hook-run',
    });
    const params = {
      amount: '7.2',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
    };
    await harness.inboundHooks.get('before_tool_call')?.({
      toolName: 'record_expense',
      params,
      runId: 'embedded-hook-run',
      toolCallId: 'embedded-hook-call',
    }, {
      runId: 'embedded-hook-run',
      toolCallId: 'embedded-hook-call',
      sessionKey: 'agent:main:main',
    });

    const result = await harness.rawRecordExpenseFactory(trustedOwnerContext()).execute(
      'embedded-hook-call',
      params,
    );

    assert.equal(result.details.status, 'created');
    assert.equal(requests.some(({ url }) => url.endsWith('/transactions/add.json')), true);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('turns a questioned direct-record call into a confirmation without writing', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'questioned-direct-record',
    });
    const result = await harness.recordExpenseFactory(trustedOwnerContext()).execute(
      'questioned-direct-record-call',
      {
        amount: '8.8',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
      },
    );

    assert.equal(result.details.status, 'pending_confirmation');
    assert.match(result.content[0].text, /^你是想记下这笔吗？/u);
    assert.equal(requests.length, 0);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('replaces the model final text with the authoritative bookkeeping receipt', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;

  try {
    const runId = await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭9',
      messageId: 'authoritative-outbound-receipt',
    });
    const params = {
      amount: '9',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
      comment: '食阁吃饭',
    };
    const result = await harness.recordExpenseFactory(trustedOwnerContext()).execute(
      'authoritative-outbound-call',
      params,
    );
    await harness.inboundHooks.get('after_tool_call')?.({
      toolName: 'record_expense',
      params,
      runId,
      toolCallId: 'authoritative-outbound-call',
      result,
    }, {
      runId,
      sessionKey: 'agent:main:main',
      toolName: 'record_expense',
    });
    const intermediate = await harness.inboundHooks.get('reply_payload_sending')?.({
      payload: { text: '正在处理工具结果' },
      kind: 'tool',
      channel: 'openclaw-weixin',
      sessionKey: 'agent:main:main',
      runId,
    }, {
      channelId: 'openclaw-weixin',
      sessionKey: 'agent:main:main',
      runId,
    });
    await harness.inboundHooks.get('after_tool_call')?.({
      toolName: 'summarize_expenses',
      params: {},
      runId,
      toolCallId: 'later-summary-call',
      result: { content: [{ type: 'text', text: '本月支出共计9元。' }] },
    }, {
      runId,
      sessionKey: 'agent:main:main',
      toolName: 'summarize_expenses',
    });
    now += 2 * 60 * 1000 + 1;
    const outgoing = await harness.inboundHooks.get('reply_payload_sending')?.({
      payload: { text: '这个月的支出记录已经更新，共计9元。' },
      kind: 'final',
      channel: 'openclaw-weixin',
      sessionKey: 'agent:main:main',
      runId,
    }, {
      channelId: 'openclaw-weixin',
      sessionKey: 'agent:main:main',
      runId,
    });

    assert.equal(intermediate, undefined);
    assert.equal(outgoing.payload.text, result.content[0].text);
    assert.match(outgoing.payload.text, /^记下来啦！🧾/u);
  } finally {
    Date.now = originalNow;
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('binds cached record tool calls to each inbound run without retaining a query turn', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const postedBodies = [];
  const harness = createPluginHarness(tempDirectory, async (url, options) => {
    if (url.endsWith('/accounts/list.json')) {
      return new Response(JSON.stringify({ success: true, result: [
        { id: 'account-1', name: '日常支出', currency: 'SGD' },
      ] }), { status: 200 });
    }
    if (url.endsWith('/transaction/categories/list.json')) {
      return new Response(JSON.stringify({ success: true, result: {
        2: [{ id: 'primary-1', name: '食品酒水', parentId: '0', subCategories: [
          { id: 'secondary-meal', name: '早午晚餐', parentId: 'primary-1' },
          { id: 'secondary-drink', name: '饮料甜品', parentId: 'primary-1' },
        ] }],
      } }), { status: 200 });
    }
    if (url.endsWith('/transactions/add.json')) {
      postedBodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        success: true,
        result: { id: `transaction-${postedBodies.length}` },
      }), { status: 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  try {
    const cachedTool = harness.rawRecordExpenseFactory(trustedOwnerContext());

    await beginTrustedOwnerTurn(harness.inboundHooks, {
      content: '这个月我花了多少钱',
      messageId: 'query-message',
      runId: 'run-query',
    });
    await harness.inboundHooks.get('agent_end')?.({}, { runId: 'run-query' });

    await beginTrustedOwnerTurn(harness.inboundHooks, {
      content: '午饭7.2',
      messageId: 'first-expense-message',
      runId: 'run-first-expense',
      timestamp: 1_788_425_460,
    });
    const first = await executeForTurn(harness.inboundHooks, cachedTool, {
      runId: 'run-first-expense',
      toolCallId: 'call-first-expense',
      params: {
        amount: '7.2',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
      },
    });
    await harness.inboundHooks.get('agent_end')?.({}, { runId: 'run-first-expense' });

    await beginTrustedOwnerTurn(harness.inboundHooks, {
      content: '咖啡3',
      messageId: 'second-expense-message',
      runId: 'run-second-expense',
      timestamp: 1_788_425_520,
    });
    const second = await executeForTurn(harness.inboundHooks, cachedTool, {
      runId: 'run-second-expense',
      toolCallId: 'call-second-expense',
      params: {
        amount: '3',
        primaryCategory: '食品酒水',
        subcategory: '饮料甜品',
      },
    });

    assert.equal(first.details.status, 'created');
    assert.equal(second.details.status, 'created');
    assert.deepEqual(postedBodies.map((body) => ({ amount: body.sourceAmount, time: body.time })), [
      { amount: 720, time: 1_788_425_460 },
      { amount: 300, time: 1_788_425_520 },
    ]);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('discards an uncorrelated query turn and fails closed without run metadata', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  let requestCount = 0;
  const harness = createPluginHarness(tempDirectory, async () => {
    requestCount += 1;
    throw new Error('HTTP must not be reached');
  });

  try {
    const cachedTool = harness.rawRecordExpenseFactory(trustedOwnerContext());
    const uncorrelatedContext = {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
      messageId: 'query-without-run',
      senderId: 'owner-user',
      sessionKey: 'agent:main:main',
    };
    await harness.inboundHooks.get('message_received')({
      content: '最近三笔支出是什么',
      timestamp: 1_788_425_460,
      messageId: 'query-without-run',
      senderId: 'owner-user',
      sessionKey: 'agent:main:main',
    }, uncorrelatedContext);
    await harness.inboundHooks.get('before_agent_run')({
      prompt: '最近三笔支出是什么',
      messages: [],
      senderIsOwner: true,
    }, uncorrelatedContext);

    await assert.rejects(
      () => cachedTool.execute('call-without-run-binding', {
        amount: '7.2',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
      }),
      /可信元数据/u,
    );

    await beginTrustedOwnerTurn(harness.inboundHooks, {
      content: '午饭7.2',
      messageId: 'expense-after-uncorrelated-query',
      runId: 'run-expense-after-uncorrelated-query',
    });
    await executeForTurn(harness.inboundHooks, cachedTool, {
      runId: 'run-expense-after-uncorrelated-query',
      toolCallId: 'call-expense-after-uncorrelated-query',
      params: {
        amount: '7.2',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
      },
    });

    assert.equal(requestCount, 1);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('does not let a non-message run consume a pending trusted inbound', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  let requestCount = 0;
  const harness = createPluginHarness(tempDirectory, async () => {
    requestCount += 1;
    throw new Error('expected prewrite failure');
  });

  try {
    const cachedTool = harness.rawRecordExpenseFactory(trustedOwnerContext());
    const messageContext = {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
      messageId: 'expense-before-non-message-run',
      senderId: 'owner-user',
      sessionKey: 'agent:main:main',
      runId: 'run-real-message',
    };
    await harness.inboundHooks.get('message_received')({
      content: '午饭7.2',
      timestamp: 1_788_425_460,
      messageId: 'expense-before-non-message-run',
      senderId: 'owner-user',
      sessionKey: 'agent:main:main',
      runId: 'run-real-message',
    }, messageContext);

    await harness.inboundHooks.get('before_agent_run')({
      prompt: '',
      messages: [],
    }, {
      runId: 'run-heartbeat',
      sessionKey: 'agent:main:main',
      trigger: 'heartbeat',
    });
    await harness.inboundHooks.get('before_agent_run')({
      prompt: '午饭7.2',
      messages: [],
      senderIsOwner: true,
    }, messageContext);
    const result = await executeForTurn(harness.inboundHooks, cachedTool, {
      runId: 'run-real-message',
      toolCallId: 'call-real-message',
      params: {
        amount: '7.2',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
      },
    });

    assert.equal(result.details.status, 'failed');
    assert.equal(requestCount, 1);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('fails both concurrent calls closed when different runs share one tool call id', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));

  try {
    const cachedTool = harness.rawRecordExpenseFactory(trustedOwnerContext());
    const firstRunId = await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭7.2',
      messageId: 'collision-first-message',
    });
    const secondRunId = await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '晚饭7.2',
      messageId: 'collision-second-message',
    });
    const params = {
      amount: '7.2',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
    };
    const results = await Promise.allSettled([
      executeForTurn(harness.inboundHooks, cachedTool, {
        runId: firstRunId,
        toolCallId: 'shared-tool-call-id',
        params,
      }),
      executeForTurn(harness.inboundHooks, cachedTool, {
        runId: secondRunId,
        toolCallId: 'shared-tool-call-id',
        params,
      }),
    ]);

    assert.deepEqual(results.map(({ status }) => status), ['rejected', 'rejected']);
    for (const result of results) {
      assert.match(result.reason.message, /可信元数据/u);
    }
    assert.equal(requests.length, 0);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('invalidates an in-flight write when another run collides before POST', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  let releaseAccountLookup;
  let signalAccountLookupStarted;
  const accountLookupStarted = new Promise((resolve) => { signalAccountLookupStarted = resolve; });
  const accountLookupReleased = new Promise((resolve) => { releaseAccountLookup = resolve; });
  const harness = createPluginHarness(tempDirectory, async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/accounts/list.json')) {
      signalAccountLookupStarted();
      await accountLookupReleased;
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
      return new Response(JSON.stringify({ success: true, result: { id: 'must-not-be-created' } }), { status: 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  try {
    const cachedTool = harness.rawRecordExpenseFactory(trustedOwnerContext());
    const params = {
      amount: '7.2',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
    };
    const firstRunId = await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭7.2',
      messageId: 'in-flight-collision-first-message',
    });
    const firstExecution = executeForTurn(harness.inboundHooks, cachedTool, {
      runId: firstRunId,
      toolCallId: 'in-flight-shared-tool-call-id',
      params,
    });
    await accountLookupStarted;

    const secondRunId = await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '晚饭7.2',
      messageId: 'in-flight-collision-second-message',
    });
    await bindToolCallForTurn(harness.inboundHooks, {
      runId: secondRunId,
      toolCallId: 'in-flight-shared-tool-call-id',
      params,
    });
    const secondExecution = cachedTool.execute('in-flight-shared-tool-call-id', params);
    releaseAccountLookup();

    const [firstResult, secondResult] = await Promise.allSettled([firstExecution, secondExecution]);
    assert.equal(firstResult.status, 'fulfilled');
    assert.equal(firstResult.value.details.status, 'failed');
    assert.equal(secondResult.status, 'rejected');
    assert.match(secondResult.reason.message, /可信元数据/u);
    assert.equal(requests.some(({ url }) => url.endsWith('/transactions/add.json')), false);
  } finally {
    releaseAccountLookup?.();
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('keeps a reused tool call id ambiguous after the first run ends', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));

  try {
    const cachedTool = harness.rawRecordExpenseFactory(trustedOwnerContext());
    const firstRunId = await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭7.2',
      messageId: 'ended-collision-first-message',
    });
    const params = {
      amount: '7.2',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
    };
    await bindToolCallForTurn(harness.inboundHooks, {
      runId: firstRunId,
      toolCallId: 'reused-after-end-id',
      params,
    });
    await harness.inboundHooks.get('agent_end')?.({
      runId: firstRunId,
      messages: [],
      success: true,
    }, { runId: firstRunId });

    const secondRunId = await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '晚饭7.2',
      messageId: 'ended-collision-second-message',
    });
    await bindToolCallForTurn(harness.inboundHooks, {
      runId: secondRunId,
      toolCallId: 'reused-after-end-id',
      params,
    });

    await assert.rejects(
      () => cachedTool.execute('reused-after-end-id', params),
      /可信元数据/u,
    );
    await assert.rejects(
      () => cachedTool.execute('reused-after-end-id', params),
      /可信元数据/u,
    );
    assert.equal(requests.length, 0);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('expires completed tool call tombstones after the trusted-message window', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));
  const originalNow = Date.now;
  let now = 2_000_000_000_000;
  Date.now = () => now;

  try {
    const cachedTool = harness.rawRecordExpenseFactory(trustedOwnerContext());
    const params = {
      amount: '7.2',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
    };
    const firstRunId = await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭7.2',
      messageId: 'expired-slot-first-message',
      timestamp: 1_788_425_460,
    });
    await bindToolCallForTurn(harness.inboundHooks, {
      runId: firstRunId,
      toolCallId: 'expired-reused-id',
      params,
    });
    await harness.inboundHooks.get('agent_end')?.({
      runId: firstRunId,
      messages: [],
      success: true,
    }, { runId: firstRunId });

    now += (10 * 60 * 1000) + 1;
    const secondRunId = await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '晚饭7.2',
      messageId: 'expired-slot-second-message',
      timestamp: 1_788_425_520,
    });
    const result = await executeForTurn(harness.inboundHooks, cachedTool, {
      runId: secondRunId,
      toolCallId: 'expired-reused-id',
      params,
    });

    assert.equal(result.details.status, 'created');
    const addRequest = requests.find(({ url }) => url.endsWith('/transactions/add.json'));
    assert.equal(JSON.parse(addRequest.options.body).time, 1_788_425_520);
  } finally {
    Date.now = originalNow;
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
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
    assert.match(harness.recordExpenseDefinition({}).description, /由你理解语义/u);
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

test('prepares an ambiguous expense, confirms it once, and keeps the original message time', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭7.2吗',
      messageId: 'ambiguous-expense',
      timestamp: 1_788_425_460,
    });
    const prepared = await harness.prepareExpenseFactory(trustedOwnerContext()).execute('prepare-1', {
      amount: '7.2',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
      comment: '食阁吃饭',
    });

    assert.equal(prepared.details.status, 'pending_confirmation');
    assert.equal(prepared.content[0].text, [
      '你是想记下这笔吗？🤔',
      '账本：[ 日常账本 ]',
      '支出：7.20 SGD',
      '分类：食品酒水 - 早午晚餐',
      '备注：食阁吃饭',
      '时间：2026/09/03 16:51',
      '回复“是”确认，回复“不是”取消。',
    ].join('\n'));
    assert.equal(requests.length, 0);

    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '是',
      messageId: 'confirm-expense',
      timestamp: 1_788_425_900,
    });
    const confirmed = await harness.resolveExpenseConfirmationFactory(trustedOwnerContext()).execute(
      'confirm-1',
      { decision: 'confirm' },
    );
    assert.equal(confirmed.details.status, 'created');
    assert.match(confirmed.content[0].text, /时间：2026\/09\/03 16:51/u);
    const addRequest = requests.find(({ url }) => url.endsWith('/transactions/add.json'));
    assert.equal(JSON.parse(addRequest.options.body).time, 1_788_425_460);

    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '是',
      messageId: 'confirm-expense-again',
    });
    const repeated = await harness.resolveExpenseConfirmationFactory(trustedOwnerContext()).execute(
      'confirm-2',
      { decision: 'confirm' },
    );
    assert.equal(repeated.details.status, 'missing');
    assert.equal(requests.filter(({ url }) => url.endsWith('/transactions/add.json')).length, 1);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('does not consume a proposal on decision mismatch and then cancels it without a write', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭7.2吗', messageId: 'pending-mismatch',
    });
    await harness.prepareExpenseFactory(trustedOwnerContext()).execute('prepare-mismatch', {
      amount: '7.2', primaryCategory: '食品酒水', subcategory: '早午晚餐',
    });
    await receiveTrustedOwnerMessage(harness.inboundHooks, { content: '是', messageId: 'mismatch-answer' });
    const mismatch = await harness.resolveExpenseConfirmationFactory(trustedOwnerContext()).execute(
      'resolve-mismatch',
      { decision: 'cancel' },
    );
    assert.equal(mismatch.details.status, 'rejected');

    await receiveTrustedOwnerMessage(harness.inboundHooks, { content: '不是', messageId: 'cancel-answer' });
    const cancelled = await harness.resolveExpenseConfirmationFactory(trustedOwnerContext()).execute(
      'resolve-cancel',
      { decision: 'cancel' },
    );
    assert.equal(cancelled.details.status, 'cancelled');
    assert.equal(requests.length, 0);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('discards an old proposal when the owner sends new substantive content', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭7.2吗', messageId: 'pending-replaced',
    });
    await harness.prepareExpenseFactory(trustedOwnerContext()).execute('prepare-replaced', {
      amount: '7.2', primaryCategory: '食品酒水', subcategory: '早午晚餐',
    });
    await receiveTrustedOwnerMessage(harness.inboundHooks, { content: '这个月花了多少', messageId: 'new-query' });
    await receiveTrustedOwnerMessage(harness.inboundHooks, { content: '是', messageId: 'late-confirm' });
    const missing = await harness.resolveExpenseConfirmationFactory(trustedOwnerContext()).execute(
      'resolve-missing',
      { decision: 'confirm' },
    );
    assert.equal(missing.details.status, 'missing');
    assert.equal(requests.length, 0);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: 'created',
    firstStatus: 'created',
    duplicateText: '同一条微信消息已处理，未重复入账。',
    fetchFailure: undefined,
    expectedRequestCount: 3,
    expectedPostCount: 1,
  },
  {
    name: 'failed',
    firstStatus: 'failed',
    duplicateText: '上一处理尝试失败，未重复入账；请重新发送一条消息重试。',
    fetchFailure: 'prewrite',
    expectedRequestCount: 1,
    expectedPostCount: 0,
  },
  {
    name: 'unknown',
    firstStatus: 'unknown',
    duplicateText: '同一条微信消息正在处理或状态未确认，未重复入账。',
    fetchFailure: 'post',
    expectedRequestCount: 3,
    expectedPostCount: 1,
  },
]) {
  test(`re-materializes a ${scenario.name} trusted-message replay for durable deduplication`, async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
    writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
    let requestCount = 0;
    let postCount = 0;
    const harness = createPluginHarness(tempDirectory, async (url) => {
      requestCount += 1;
      if (scenario.fetchFailure === 'prewrite') throw new Error('prewrite unavailable');
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
        postCount += 1;
        if (scenario.fetchFailure === 'post') throw new Error('post outcome unavailable');
        return new Response(JSON.stringify({ success: true, result: { id: 'transaction-replay' } }), { status: 200 });
      }
      throw new Error('unexpected test request');
    });

    const message = {
      content: 'NTUC购物8.25，买了两根芹菜，一个菜板',
      messageId: `wechat-message-replay-${scenario.name}`,
    };
    const params = {
      amount: '8.25', primaryCategory: '食品酒水', subcategory: '超市购物',
    };
    try {
      await receiveTrustedOwnerMessage(harness.inboundHooks, message);
      const first = await harness.recordExpenseFactory(trustedOwnerContext()).execute(
        `tool-call-replay-${scenario.name}-first`,
        params,
      );
      assert.equal(first.details.status, scenario.firstStatus);
      assert.equal(requestCount, scenario.expectedRequestCount);
      assert.equal(postCount, scenario.expectedPostCount);

      await receiveTrustedOwnerMessage(harness.inboundHooks, message);
      const replay = await harness.recordExpenseFactory(trustedOwnerContext()).execute(
        `tool-call-replay-${scenario.name}-second`,
        params,
      );

      assert.equal(replay.content[0].text, scenario.duplicateText);
      assert.equal(replay.details.status, 'duplicate');
      assert.equal(requestCount, scenario.expectedRequestCount);
      assert.equal(postCount, scenario.expectedPostCount);
    } finally {
      harness.restore();
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
}

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

test('keeps a tool call bound to its inbound run when a later message arrives', async () => {
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
    const cachedTool = harness.rawRecordExpenseFactory(trustedOwnerContext());
    const firstRunId = await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭7.2，备注鸡饭',
      messageId: 'wechat-message-first',
      timestamp: 1_788_425_460,
    });
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '出租车7.2，备注回家',
      messageId: 'wechat-message-second',
      timestamp: 1_788_425_520,
    });
    const result = await executeForTurn(harness.inboundHooks, cachedTool, {
      runId: firstRunId,
      toolCallId: 'tool-call-bound-first',
      params: {
        amount: '7.2',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
      },
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

test('binds overlapping inbound runs independently of tool materialization order', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const addBodies = [];
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
      addBodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ success: true, result: { id: `transaction-${addBodies.length}` } }), { status: 200 });
    }
    throw new Error('unexpected test request');
  });

  try {
    const cachedTool = harness.rawRecordExpenseFactory(trustedOwnerContext());
    const firstRunId = await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭7.2，备注第一笔', messageId: 'wechat-message-fifo-1', timestamp: 1_788_425_460,
    });
    const secondRunId = await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '晚饭8.3，备注第二笔', messageId: 'wechat-message-fifo-2', timestamp: 1_788_425_520,
    });

    const first = await executeForTurn(harness.inboundHooks, cachedTool, {
      runId: firstRunId,
      toolCallId: 'tool-call-fifo-1',
      params: { amount: '7.2', primaryCategory: '食品酒水', subcategory: '早午晚餐' },
    });
    const second = await executeForTurn(harness.inboundHooks, cachedTool, {
      runId: secondRunId,
      toolCallId: 'tool-call-fifo-2',
      params: { amount: '8.3', primaryCategory: '食品酒水', subcategory: '早午晚餐' },
    });

    assert.equal(first.details.status, 'created');
    assert.equal(second.details.status, 'created');
    assert.deepEqual(addBodies.map(({ sourceAmount, comment, time }) => ({ sourceAmount, comment, time })), [
      { sourceAmount: 720, comment: '第一笔', time: 1_788_425_460 },
      { sourceAmount: 830, comment: '第二笔', time: 1_788_425_520 },
    ]);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('keeps a cached record tool closed without a tool-call binding', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  let requestCount = 0;
  const harness = createPluginHarness(tempDirectory, async () => {
    requestCount += 1;
    throw new Error('HTTP must not be reached');
  });

  try {
    const toolWithoutSnapshot = harness.rawRecordExpenseFactory(trustedOwnerContext());
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
    await receiveTrustedOwnerMessage(harness.inboundHooks, { messageId: 'wechat-message-unknown' });
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

    assert.equal(result.content[0].text, '这条消息的金额与当前请求不一致，或仍带有疑问，本次没有入账。');
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
    await receiveTrustedOwnerMessage(harness.inboundHooks, { messageId: 'wechat-message-post-timeout' });
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

test('keeps the stable failed result when failed-state persistence is unavailable', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const originalFail = SqliteReceiptStore.prototype.fail;
  SqliteReceiptStore.prototype.fail = () => { throw new Error('receipt state unavailable'); };
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('prewrite connection failed');
  });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, { messageId: 'wechat-message-fail-persistence' });
    const result = await harness.recordExpenseFactory(trustedOwnerContext()).execute(
      'tool-call-fail-persistence',
      { amount: '8.25', primaryCategory: '食品酒水', subcategory: '超市购物' },
    );

    assert.equal(result.content[0].text, '账本暂时连不上，本次没有写入任何数据，请稍后再试。');
    assert.deepEqual(result.details, { status: 'failed', dedupeStatus: 'unconfirmed' });
    assert.equal(harness.logs.some((entry) => /deduplication persistence is unconfirmed/u.test(entry)), true);
    assert.equal(result.content[0].text.includes('unconfirmed'), false);
  } finally {
    SqliteReceiptStore.prototype.fail = originalFail;
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('keeps the stable unknown result when uncertain-state persistence is unavailable', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const originalUncertain = SqliteReceiptStore.prototype.uncertain;
  SqliteReceiptStore.prototype.uncertain = () => { throw new Error('receipt state unavailable'); };
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
    if (url.endsWith('/transactions/add.json')) throw new Error('post outcome unavailable');
    throw new Error('unexpected test request');
  });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, { messageId: 'wechat-message-uncertain-persistence' });
    const result = await harness.recordExpenseFactory(trustedOwnerContext()).execute(
      'tool-call-uncertain-persistence',
      { amount: '8.25', primaryCategory: '食品酒水', subcategory: '超市购物' },
    );

    assert.equal(result.content[0].text, '记账请求已发送，但结果暂时无法确认。请先打开账本核对，不要重复发送这条消费。');
    assert.deepEqual(result.details, { status: 'unknown', dedupeStatus: 'unconfirmed' });
    assert.equal(harness.logs.some((entry) => /deduplication persistence is unconfirmed/u.test(entry)), true);
    assert.equal(result.content[0].text.includes('unconfirmed'), false);
  } finally {
    SqliteReceiptStore.prototype.uncertain = originalUncertain;
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
