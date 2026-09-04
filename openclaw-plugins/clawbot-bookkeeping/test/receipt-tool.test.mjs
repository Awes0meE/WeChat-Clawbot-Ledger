import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import plugin from '../index.ts';
import { SqliteReceiptStore } from '../adapter.mjs';

function receivedExpenseParams(overrides = {}) {
  return {
    amount: '7.2',
    currency: 'SGD',
    timeMode: 'received',
    primaryCategory: '食品酒水',
    subcategory: '早午晚餐',
    ...overrides,
  };
}

function normalizeExpenseTestParams(toolName, params) {
  return toolName === 'record_expense' || toolName === 'prepare_expense'
    ? receivedExpenseParams(params)
    : params;
}

function createPluginHarness(tempDirectory, fetchImpl, pluginConfig = {}) {
  const inboundHooks = new Map();
  const hookOptions = new Map();
  let recordExpenseFactory;
  let prepareExpenseFactory;
  let resolveExpenseConfirmationFactory;
  let recordExpenseDefinition;
  let prepareExpenseDefinition;
  const logs = [];
  const pluginApi = {
    pluginConfig: {
      serverBaseUrl: 'http://127.0.0.1:8888',
      tokenPath: join(tempDirectory, 'token.txt'),
      stateDbPath: join(tempDirectory, 'receipts.sqlite'),
      accountName: '日常支出',
      ...pluginConfig,
    },
    on(name, handler, options) {
      inboundHooks.set(name, handler);
      hookOptions.set(name, options);
    },
    registerTool(definition, options) {
      if (typeof definition === 'function' && options?.name === 'record_expense') {
        recordExpenseFactory = definition;
        recordExpenseDefinition = definition;
      }
      if (typeof definition === 'function' && options?.name === 'prepare_expense') {
        prepareExpenseFactory = definition;
        prepareExpenseDefinition = definition;
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

  const materializeRawExpenseTool = (factory, toolName, toolContext) => {
    const tool = factory(toolContext);
    return {
      ...tool,
      execute(toolCallId, params) {
        return tool.execute(toolCallId, normalizeExpenseTestParams(toolName, params));
      },
    };
  };

  return {
    inboundHooks,
    hookOptions,
    recordExpenseFactory: (context) => materializeExpenseTool(recordExpenseFactory, 'record_expense', context),
    prepareExpenseFactory: (context) => materializeExpenseTool(prepareExpenseFactory, 'prepare_expense', context),
    resolveExpenseConfirmationFactory: (context) => materializeExpenseTool(
      resolveExpenseConfirmationFactory,
      'resolve_expense_confirmation',
      context,
    ),
    rawRecordExpenseFactory: (context) => materializeRawExpenseTool(
      recordExpenseFactory,
      'record_expense',
      context,
    ),
    rawPrepareExpenseFactory: (context) => materializeRawExpenseTool(
      prepareExpenseFactory,
      'prepare_expense',
      context,
    ),
    rawResolveExpenseConfirmationFactory: resolveExpenseConfirmationFactory,
    recordExpenseDefinition,
    prepareExpenseDefinition,
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
  const normalizedParams = normalizeExpenseTestParams(toolName, params);
  await bindToolCallForTurn(inboundHooks, {
    runId,
    toolCallId,
    toolName,
    params: normalizedParams,
  });
  return tool.execute(toolCallId, normalizedParams);
}

async function bindToolCallForTurn(inboundHooks, {
  runId,
  toolCallId,
  toolName = 'record_expense',
  params,
}) {
  const normalizedParams = normalizeExpenseTestParams(toolName, params);
  await inboundHooks.get('before_tool_call')?.({
    toolName,
    params: normalizedParams,
    runId,
    toolCallId,
  }, {
    runId,
    toolCallId,
    sessionKey: 'agent:main:main',
    channelId: 'openclaw-weixin',
    requester: {
      channel: 'openclaw-weixin',
      accountId: 'bot-account',
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

async function receiveTrustedOwnerMessageWithoutBeforeAgentRun(inboundHooks, {
  content,
  messageId,
  timestamp = 1_788_425_460,
}) {
  const runId = `run-${messageId}-${++receiveTrustedOwnerMessage.sequence}`;
  inboundHooks.latestRunId = runId;
  const messageContext = {
    channelId: 'openclaw-weixin',
    accountId: 'bot-account',
    messageId,
    senderId: 'owner-user',
    sessionKey: 'agent:main:main',
  };
  await inboundHooks.get('message_received')({
    content,
    timestamp,
    messageId,
    senderId: 'owner-user',
    sessionKey: 'agent:main:main',
  }, messageContext);
  await inboundHooks.get('llm_input')?.({
    runId,
    sessionId: 'codex-session',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    prompt: `OpenClaw runtime context for this turn:\n...\n\nCurrent user request:\n${content}`,
    historyMessages: [],
    imagesCount: 0,
  }, {
    runId,
    agentId: 'bookkeeper',
    sessionKey: 'agent:main:main',
    sessionId: 'codex-session',
    channel: 'openclaw-weixin',
    accountId: 'bot-account',
    trigger: 'user',
  });
  return runId;
}

test('declares the fixed ledger display name in the plugin manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.configSchema.properties.ledgerDisplayName, {
    type: 'string',
    const: '日常账本',
  });
});

test('requires an explicit SGD currency and time decision in both expense tools', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run while inspecting tool schemas');
  });
  try {
    const recordSchema = harness.recordExpenseDefinition({}).parameters;
    const prepareSchema = harness.prepareExpenseDefinition({}).parameters;
    for (const schema of [recordSchema, prepareSchema]) {
      assert.equal(schema.anyOf.length, 2);
      assert.deepEqual(
        schema.anyOf.map((branch) => branch.properties.timeMode.const),
        ['received', 'explicit'],
      );
      assert.equal(
        schema.anyOf.every((branch) => branch.properties.currency.const === 'SGD'),
        true,
      );
      assert.equal(schema.anyOf.every((branch) => branch.required.includes('currency')), true);
      assert.equal(schema.anyOf.every((branch) => branch.required.includes('timeMode')), true);
      assert.equal(schema.anyOf[0].required.includes('localDate'), false);
      assert.equal(schema.anyOf[1].required.includes('localDate'), true);
      assert.equal(schema.anyOf[1].required.includes('timeEvidence'), true);
    }
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('injects only the correlated trusted send time into an authorized prompt', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run while building prompt context');
  });
  try {
    await beginTrustedOwnerTurn(harness.inboundHooks, {
      content: '昨天晚上6点，晚饭10.5',
      messageId: 'time-context-1',
      runId: 'run-time-context-1',
      timestamp: 1_788_512_940,
    });
    const result = await harness.inboundHooks.get('before_prompt_build')?.({
      prompt: '昨天晚上6点，晚饭10.5',
      messages: [],
    }, {
      runId: 'run-time-context-1',
      trigger: 'user',
      toolAuthority: {
        assertActive() {},
        allows(name) { return name === 'record_expense'; },
      },
    });
    assert.match(result?.prependContext ?? '', /2026-09-04 17:09/u);
    assert.equal(/owner-user|time-context-1|bot-account/u.test(result.prependContext), false);
    assert.equal(harness.hookOptions.get('before_prompt_build')?.requiresToolAuthority, true);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
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

test('binds a trusted owner message when Codex omits sender identity from llm_input', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run while preparing confirmation');
  });

  try {
    const runId = await receiveTrustedOwnerMessageWithoutBeforeAgentRun(harness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'codex-without-before-agent-run',
    });
    const params = {
      amount: '8.8',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
      comment: '午饭',
    };
    const tool = harness.prepareExpenseFactory(trustedOwnerContext());
    const prepared = await executeForTurn(harness.inboundHooks, tool, {
      runId,
      toolCallId: 'codex-prepare-call',
      toolName: 'prepare_expense',
      params,
    });

    assert.equal(prepared.details.status, 'pending_confirmation');
    assert.match(prepared.content[0].text, /支出：8\.80 SGD/u);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('rejects a Codex tool requester that does not match the correlated sender', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));

  try {
    const runId = await receiveTrustedOwnerMessageWithoutBeforeAgentRun(harness.inboundHooks, {
      content: '午饭8.8',
      messageId: 'codex-requester-mismatch',
    });
    const params = {
      amount: '8.8',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
    };
    await harness.inboundHooks.get('before_tool_call')?.({
      toolName: 'record_expense',
      params,
      runId,
      toolCallId: 'codex-requester-mismatch-call',
    }, {
      runId,
      toolCallId: 'codex-requester-mismatch-call',
      sessionKey: 'agent:main:main',
      channelId: 'openclaw-weixin',
      requester: {
        channel: 'openclaw-weixin',
        accountId: 'bot-account',
        senderId: 'different-owner',
        senderIsOwner: true,
      },
    });

    await assert.rejects(
      () => harness.rawRecordExpenseFactory(trustedOwnerContext()).execute(
        'codex-requester-mismatch-call',
        params,
      ),
      /可信元数据/u,
    );
    assert.equal(requests.length, 0);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('replays the first authoritative result when Codex calls a tool twice in one run', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run while preparing confirmation');
  });

  try {
    const runId = await receiveTrustedOwnerMessageWithoutBeforeAgentRun(harness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'codex-duplicate-tool-call',
    });
    const params = {
      amount: '8.8',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
      comment: '午饭',
    };
    const tool = harness.rawPrepareExpenseFactory(trustedOwnerContext());
    const first = await executeForTurn(harness.inboundHooks, tool, {
      runId,
      toolCallId: 'codex-first-call',
      toolName: 'prepare_expense',
      params,
    });
    const replay = await executeForTurn(harness.inboundHooks, tool, {
      runId,
      toolCallId: 'codex-second-call',
      toolName: 'prepare_expense',
      params,
    });

    assert.equal(first.details.status, 'pending_confirmation');
    assert.strictEqual(replay, first);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('correlates a resumed Codex call when hook and execute ids differ', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run while preparing confirmation');
  });

  try {
    const runId = await receiveTrustedOwnerMessageWithoutBeforeAgentRun(harness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'codex-resumed-id-mismatch',
    });
    const params = {
      amount: '8.8',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
      comment: '午饭',
    };
    await bindToolCallForTurn(harness.inboundHooks, {
      runId,
      toolCallId: 'codex-hook-call-id',
      toolName: 'prepare_expense',
      params: {
        amount: params.amount,
        primaryCategory: params.primaryCategory,
        subcategory: params.subcategory,
      },
    });

    const tool = harness.rawPrepareExpenseFactory(trustedOwnerContext());
    const result = await tool.execute('codex-execute-call-id', params);

    assert.equal(result.details.status, 'pending_confirmation');
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('correlates a compacted Codex call when the tool factory keeps stale session context', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run while preparing confirmation');
  });

  try {
    const runId = await receiveTrustedOwnerMessageWithoutBeforeAgentRun(harness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'codex-compacted-stale-session',
    });
    const params = {
      amount: '8.8',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
      comment: '午饭',
    };
    await bindToolCallForTurn(harness.inboundHooks, {
      runId,
      toolCallId: 'codex-current-hook-id',
      toolName: 'prepare_expense',
      params,
    });

    const tool = harness.rawPrepareExpenseFactory({
      ...trustedOwnerContext(),
      sessionKey: 'agent:main:stale-compacted-session',
    });
    const result = await tool.execute('codex-resumed-execute-id', params);

    assert.equal(result.details.status, 'pending_confirmation');
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('fails compacted Codex recovery closed when two authorized runs match the same tool', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run while preparing confirmation');
  });

  try {
    const params = {
      amount: '8.8',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
      comment: '午饭',
    };
    const firstRunId = await receiveTrustedOwnerMessageWithoutBeforeAgentRun(harness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'codex-compacted-first-run',
    });
    await bindToolCallForTurn(harness.inboundHooks, {
      runId: firstRunId,
      toolCallId: 'codex-compacted-first-hook',
      toolName: 'prepare_expense',
      params,
    });
    const secondRunId = await receiveTrustedOwnerMessageWithoutBeforeAgentRun(harness.inboundHooks, {
      content: '晚饭8.8么？',
      messageId: 'codex-compacted-second-run',
    });
    await bindToolCallForTurn(harness.inboundHooks, {
      runId: secondRunId,
      toolCallId: 'codex-compacted-second-hook',
      toolName: 'prepare_expense',
      params,
    });

    const tool = harness.rawPrepareExpenseFactory({
      ...trustedOwnerContext(),
      sessionKey: 'agent:main:stale-compacted-session',
    });
    await assert.rejects(
      () => tool.execute('codex-compacted-ambiguous-execute', params),
      /可信元数据/u,
    );
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('correlates multiple Codex pre-execution events from the same run', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run while preparing confirmation');
  });

  try {
    const runId = await receiveTrustedOwnerMessageWithoutBeforeAgentRun(harness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'codex-multiple-pre-execution-events',
    });
    const params = {
      amount: '8.8',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
      comment: '午饭',
    };
    await bindToolCallForTurn(harness.inboundHooks, {
      runId,
      toolCallId: 'codex-first-hook-id',
      toolName: 'prepare_expense',
      params,
    });
    await bindToolCallForTurn(harness.inboundHooks, {
      runId,
      toolCallId: 'codex-second-hook-id',
      toolName: 'prepare_expense',
      params,
    });

    const tool = harness.rawPrepareExpenseFactory(trustedOwnerContext());
    const result = await tool.execute('codex-third-execute-id', params);

    assert.equal(result.details.status, 'pending_confirmation');
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('uses the trusted owner message when compacted tool context loses the owner flag', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'compacted-owner-context',
    });
    const result = await harness.prepareExpenseFactory({
      ...trustedOwnerContext(),
      senderIsOwner: false,
    }).execute('compacted-owner-context-call', {
      amount: '8.8',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
      comment: '午饭',
    });

    assert.equal(result.details.status, 'pending_confirmation');
    assert.match(result.content[0].text, /^帮你核对一下这笔～🤔/u);
    assert.equal(requests.length, 0);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('binds the exact owner conversation when current transport metadata is absent from run history', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));

  try {
    const commonContext = {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
      senderId: 'owner-user',
      sessionKey: 'agent:main:main',
    };
    await harness.inboundHooks.get('message_received')?.({
      content: '/status',
      timestamp: 1_788_425_400,
      messageId: 'command-without-agent-run',
      senderId: 'owner-user',
      sessionKey: 'agent:main:main',
    }, {
      ...commonContext,
      messageId: 'command-without-agent-run',
    });
    await harness.inboundHooks.get('message_received')?.({
      content: '昨天中午在食阁吃饭，花了6块五加两块五',
      timestamp: 1_788_425_460,
      messageId: 'live-host-message',
      senderId: 'owner-user',
      sessionKey: 'agent:main:main',
    }, {
      ...commonContext,
      messageId: 'live-host-message',
    });
    await harness.inboundHooks.get('before_agent_run')?.({
      prompt: '昨天中午在食阁吃饭，花了6块五加两块五',
      messages: [],
      senderIsOwner: true,
    }, {
      ...commonContext,
      runId: 'embedded-run-id',
      trigger: 'user',
    });
    const params = {
      amount: '9',
      currency: 'SGD',
      timeMode: 'explicit',
      localDate: '2026-09-02',
      timeEvidence: '昨天中午',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
      comment: '食阁',
    };
    await bindToolCallForTurn(harness.inboundHooks, {
      runId: 'embedded-run-id',
      toolCallId: 'live-host-call',
      params,
    });
    const result = await harness.rawRecordExpenseFactory(trustedOwnerContext()).execute(
      'live-host-call',
      params,
    );

    assert.equal(result.details.status, 'created');
    assert.equal(requests.some(({ url }) => url.endsWith('/transactions/add.json')), true);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('does not bind an identical prompt queued by a different sender', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));
  const sharedSession = 'agent:main:shared';

  try {
    await harness.inboundHooks.get('message_received')?.({
      content: '午饭9',
      messageId: 'other-sender-message',
      senderId: 'other-user',
      sessionKey: sharedSession,
    }, {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
      messageId: 'other-sender-message',
      senderId: 'other-user',
      sessionKey: sharedSession,
    });
    await harness.inboundHooks.get('before_agent_run')?.({
      prompt: '午饭9',
      messages: [],
      senderIsOwner: true,
    }, {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
      senderId: 'owner-user',
      sessionKey: sharedSession,
      runId: 'owner-run-with-other-sender-prompt',
      trigger: 'user',
    });
    const params = { amount: '9', primaryCategory: '食品酒水', subcategory: '早午晚餐' };
    await bindToolCallForTurn(harness.inboundHooks, {
      runId: 'owner-run-with-other-sender-prompt',
      toolCallId: 'other-sender-collision-call',
      params,
    });

    await assert.rejects(
      () => harness.rawRecordExpenseFactory(trustedOwnerContext()).execute(
        'other-sender-collision-call',
        params,
      ),
      /可信元数据/u,
    );
    assert.equal(requests.length, 0);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('does not claim a definite no-write outcome for an unknown tool exception', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not be reached');
  });

  try {
    await harness.inboundHooks.get('after_tool_call')?.({
      toolName: 'record_expense',
      params: { amount: '9' },
      runId: 'unknown-error-run',
      toolCallId: 'unknown-error-call',
      result: { content: [{ type: 'text', text: '{"status":"error"}' }], isError: true },
      error: 'post-write cleanup failed: 缺少当前微信消息的可信元数据，已拒绝操作账本。',
    }, {
      runId: 'unknown-error-run',
      sessionKey: 'agent:main:main',
      toolName: 'record_expense',
    });
    const outgoing = await harness.inboundHooks.get('reply_payload_sending')?.({
      payload: { text: '已记账' },
      kind: 'final',
      channel: 'openclaw-weixin',
      sessionKey: 'agent:main:main',
      runId: 'unknown-error-run',
    }, {
      channelId: 'openclaw-weixin',
      sessionKey: 'agent:main:main',
      runId: 'unknown-error-run',
    });

    assert.equal(outgoing.payload.text, '记账结果无法确认，请先查看账本，暂时不要重复发送。');
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('ignores older history metadata and binds the current queued prompt', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));
  const commonContext = {
    channelId: 'openclaw-weixin',
    accountId: 'bot-account',
    senderId: 'owner-user',
    sessionKey: 'agent:main:main',
  };

  try {
    await harness.inboundHooks.get('message_received')?.({
      content: '午饭9',
      timestamp: 1_788_425_400,
      messageId: 'older-nine-dollar-message',
      senderId: 'owner-user',
      sessionKey: 'agent:main:main',
    }, {
      ...commonContext,
      messageId: 'older-nine-dollar-message',
    });
    await harness.inboundHooks.get('message_received')?.({
      content: '晚饭9',
      timestamp: 1_788_425_460,
      messageId: 'current-message-with-missing-hook-metadata',
      senderId: 'owner-user',
      sessionKey: 'agent:main:main',
    }, {
      ...commonContext,
      messageId: 'current-message-with-missing-hook-metadata',
    });
    await harness.inboundHooks.get('before_agent_run')?.({
      prompt: '晚饭9',
      messages: [{
        role: 'user',
        content: '午饭9',
        __openclaw: {
          senderIsOwner: true,
          transport: {
            channel: 'openclaw-weixin',
            messageId: 'older-nine-dollar-message',
          },
        },
      }, {
        role: 'user',
        content: '晚饭9',
      }],
      senderIsOwner: true,
    }, {
      ...commonContext,
      runId: 'current-run-with-missing-message-metadata',
      trigger: 'user',
    });
    const params = {
      amount: '9',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
      comment: '晚饭',
    };
    await bindToolCallForTurn(harness.inboundHooks, {
      runId: 'current-run-with-missing-message-metadata',
      toolCallId: 'missing-current-metadata-call',
      params,
    });

    const result = await harness.rawRecordExpenseFactory(trustedOwnerContext()).execute(
      'missing-current-metadata-call',
      params,
    );
    assert.equal(result.details.status, 'created');
    assert.equal(requests.some(({ url }) => url.endsWith('/transactions/add.json')), true);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('replaces a false success claim with an authoritative no-write result', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not be reached');
  });

  try {
    await bindToolCallForTurn(harness.inboundHooks, {
      runId: 'failed-live-run',
      toolCallId: 'failed-live-call',
      toolName: 'record_expense',
      params: { amount: '9' },
    });
    await assert.rejects(
      () => harness.rawRecordExpenseFactory(trustedOwnerContext()).execute(
        'failed-live-call',
        { amount: '9', primaryCategory: '食品酒水', subcategory: '早午晚餐' },
      ),
      /可信元数据/u,
    );
    const outgoing = await harness.inboundHooks.get('reply_payload_sending')?.({
      payload: { text: '已记账' },
      kind: 'final',
      channel: 'openclaw-weixin',
      sessionKey: 'agent:main:main',
      runId: 'failed-live-run',
    }, {
      channelId: 'openclaw-weixin',
      sessionKey: 'agent:main:main',
      runId: 'failed-live-run',
    });

    assert.equal(outgoing.payload.text, '这次没记成功，账本里没有新增记录～ 请重新发一条新消息吧。');
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
    assert.match(result.content[0].text, /^帮你核对一下这笔～🤔/u);
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

test('replaces a WeChat provider send with the authoritative tool receipt', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run for a confirmation');
  });

  try {
    const runId = await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'authoritative-wechat-confirmation',
    });
    const result = await harness.prepareExpenseFactory(trustedOwnerContext()).execute(
      'authoritative-wechat-confirmation-call',
      {
        amount: '8.8',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
        comment: '午饭',
      },
    );
    const outgoing = await harness.inboundHooks.get('message_sending')?.({
      to: 'owner-user',
      content: '是',
      metadata: {
        channel: 'openclaw-weixin',
        accountId: 'bot-account',
        runId,
      },
    }, {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
    });

    assert.equal(outgoing.content, result.content[0].text);
    assert.match(outgoing.content, /^帮你核对一下这笔～🤔\n- 账本：/u);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('replaces a WeChat send when the Codex tool and outbound run ids differ', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run for a confirmation');
  });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'authoritative-wechat-cross-run-confirmation',
    });
    const result = await harness.prepareExpenseFactory(trustedOwnerContext()).execute(
      'authoritative-wechat-cross-run-call',
      {
        amount: '8.8',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
        comment: '午饭',
      },
    );
    const outboundRunId = 'outer-wechat-delivery-run';
    const outgoing = await harness.inboundHooks.get('message_sending')?.({
      to: 'owner-user',
      content: '是',
      metadata: {
        channel: 'openclaw-weixin',
        accountId: 'bot-account',
        runId: outboundRunId,
      },
    }, {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
      runId: outboundRunId,
    });

    assert.equal(outgoing.content, result.content[0].text);

    await harness.inboundHooks.get('message_sent')?.({
      to: 'owner-user',
      content: outgoing.content,
      success: true,
      runId: outboundRunId,
    }, {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
      runId: outboundRunId,
    });
    const afterSuccessfulSend = await harness.inboundHooks.get('message_sending')?.({
      to: 'owner-user',
      content: '普通后续消息',
      metadata: {
        channel: 'openclaw-weixin',
        accountId: 'bot-account',
        runId: outboundRunId,
      },
    }, {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
      runId: outboundRunId,
    });
    assert.equal(afterSuccessfulSend, undefined);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('does not recover an authoritative WeChat reply for a different recipient', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run for a confirmation');
  });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'authoritative-wechat-other-recipient',
    });
    await harness.prepareExpenseFactory(trustedOwnerContext()).execute(
      'authoritative-wechat-other-recipient-call',
      {
        amount: '8.8',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
        comment: '午饭',
      },
    );
    const outgoing = await harness.inboundHooks.get('message_sending')?.({
      to: 'different-user',
      content: '普通回复',
      metadata: {
        channel: 'openclaw-weixin',
        accountId: 'bot-account',
        runId: 'outer-wechat-other-recipient-run',
      },
    }, {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
      runId: 'outer-wechat-other-recipient-run',
    });

    assert.equal(outgoing, undefined);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('does not reuse an outbound reservation for a different recipient with the same run id', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run for a confirmation');
  });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'authoritative-wechat-reservation-recipient',
    });
    await harness.prepareExpenseFactory(trustedOwnerContext()).execute(
      'authoritative-wechat-reservation-recipient-call',
      {
        amount: '8.8',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
        comment: '午饭',
      },
    );
    const outboundRunId = 'outer-wechat-reused-recipient-run';
    const first = await harness.inboundHooks.get('message_sending')?.({
      to: 'owner-user',
      content: '普通回复',
      metadata: {
        channel: 'openclaw-weixin',
        accountId: 'bot-account',
        runId: outboundRunId,
      },
    }, {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
      runId: outboundRunId,
    });
    assert.ok(first);

    const second = await harness.inboundHooks.get('message_sending')?.({
      to: 'different-user',
      content: '普通回复',
      metadata: {
        channel: 'openclaw-weixin',
        accountId: 'bot-account',
        runId: outboundRunId,
      },
    }, {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
      runId: outboundRunId,
    });

    assert.equal(second, undefined);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('releases an authoritative reply reservation after a failed WeChat send', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run for a confirmation');
  });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'authoritative-wechat-failed-delivery',
    });
    const result = await harness.prepareExpenseFactory(trustedOwnerContext()).execute(
      'authoritative-wechat-failed-delivery-call',
      {
        amount: '8.8',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
        comment: '午饭',
      },
    );
    const firstRunId = 'outer-wechat-failed-delivery-run';
    const first = await harness.inboundHooks.get('message_sending')?.({
      to: 'owner-user',
      content: '普通回复',
      metadata: { channel: 'openclaw-weixin', runId: firstRunId },
    }, {
      channelId: 'openclaw-weixin',
      runId: firstRunId,
    });
    assert.equal(first.content, result.content[0].text);

    await harness.inboundHooks.get('message_sent')?.({
      to: 'owner-user',
      content: first.content,
      success: false,
      runId: firstRunId,
    }, {
      channelId: 'openclaw-weixin',
      runId: firstRunId,
    });
    const retryRunId = 'outer-wechat-failed-delivery-retry';
    const retried = await harness.inboundHooks.get('message_sending')?.({
      to: 'owner-user',
      content: '普通回复',
      metadata: { channel: 'openclaw-weixin', runId: retryRunId },
    }, {
      channelId: 'openclaw-weixin',
      runId: retryRunId,
    });

    assert.equal(retried.content, result.content[0].text);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('recovers an authoritative WeChat reply when outbound account metadata is absent', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run for a confirmation');
  });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'authoritative-wechat-missing-outbound-account',
    });
    const result = await harness.prepareExpenseFactory(trustedOwnerContext()).execute(
      'authoritative-wechat-missing-outbound-account-call',
      {
        amount: '8.8',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
        comment: '午饭',
      },
    );
    const outgoing = await harness.inboundHooks.get('message_sending')?.({
      to: 'owner-user',
      content: '普通回复',
      metadata: {
        channel: 'openclaw-weixin',
        runId: 'outer-wechat-missing-account-run',
      },
    }, {
      channelId: 'openclaw-weixin',
      runId: 'outer-wechat-missing-account-run',
    });

    assert.equal(outgoing.content, result.content[0].text);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('recovers an authoritative WeChat reply across isolated plugin instances', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const firstHarness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run for a confirmation');
  });
  let secondHarness;

  try {
    await receiveTrustedOwnerMessage(firstHarness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'authoritative-wechat-cross-instance',
    });
    const result = await firstHarness.prepareExpenseFactory(trustedOwnerContext()).execute(
      'authoritative-wechat-cross-instance-call',
      {
        amount: '8.8',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
        comment: '午饭',
      },
    );

    secondHarness = createPluginHarness(tempDirectory, async () => {
      throw new Error('HTTP must not run for a confirmation');
    });
    const outboundRunId = 'outer-wechat-cross-instance-run';
    const outgoing = await secondHarness.inboundHooks.get('message_sending')?.({
      to: 'owner-user',
      content: '普通回复',
      metadata: {
        channel: 'openclaw-weixin',
        runId: outboundRunId,
      },
    }, {
      channelId: 'openclaw-weixin',
      runId: outboundRunId,
    });

    assert.equal(outgoing.content, result.content[0].text);

    await secondHarness.inboundHooks.get('message_sent')?.({
      to: 'owner-user',
      content: outgoing.content,
      success: true,
      runId: outboundRunId,
    }, {
      channelId: 'openclaw-weixin',
      runId: outboundRunId,
    });
    const afterSuccessfulSend = await firstHarness.inboundHooks.get('message_sending')?.({
      to: 'owner-user',
      content: '普通后续消息',
      metadata: {
        channel: 'openclaw-weixin',
        runId: 'outer-wechat-cross-instance-later-run',
      },
    }, {
      channelId: 'openclaw-weixin',
      runId: 'outer-wechat-cross-instance-later-run',
    });
    assert.equal(afterSuccessfulSend, undefined);
  } finally {
    secondHarness?.restore();
    firstHarness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('fails cross-run WeChat recovery closed when two replies target the same recipient', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run for a confirmation');
  });

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'authoritative-wechat-ambiguous-one',
    });
    await harness.prepareExpenseFactory(trustedOwnerContext()).execute(
      'authoritative-wechat-ambiguous-one-call',
      {
        amount: '8.8',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
        comment: '午饭',
      },
    );
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '晚饭9.9么？',
      messageId: 'authoritative-wechat-ambiguous-two',
    });
    await harness.prepareExpenseFactory(trustedOwnerContext()).execute(
      'authoritative-wechat-ambiguous-two-call',
      {
        amount: '9.9',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
        comment: '晚饭',
      },
    );
    const outgoing = await harness.inboundHooks.get('message_sending')?.({
      to: 'owner-user',
      content: '普通回复',
      metadata: {
        channel: 'openclaw-weixin',
        accountId: 'bot-account',
        runId: 'outer-wechat-ambiguous-run',
      },
    }, {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
      runId: 'outer-wechat-ambiguous-run',
    });

    assert.equal(outgoing, undefined);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('keeps the authoritative receipt through the generic and WeChat send hooks', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run for a confirmation');
  });

  try {
    const runId = await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'authoritative-hook-chain-confirmation',
    });
    const result = await harness.prepareExpenseFactory(trustedOwnerContext()).execute(
      'authoritative-hook-chain-call',
      {
        amount: '8.8',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
        comment: '午饭',
      },
    );
    const genericOutgoing = await harness.inboundHooks.get('reply_payload_sending')?.({
      payload: { text: '是' },
      kind: 'final',
      channel: 'openclaw-weixin',
      sessionKey: 'agent:main:main',
      runId,
    }, {
      channelId: 'openclaw-weixin',
      sessionKey: 'agent:main:main',
      runId,
    });
    const wechatOutgoing = await harness.inboundHooks.get('message_sending')?.({
      to: 'owner-user',
      content: genericOutgoing.payload.text,
      metadata: {
        channel: 'openclaw-weixin',
        accountId: 'bot-account',
        runId,
      },
    }, {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
    });

    assert.equal(genericOutgoing.payload.text, result.content[0].text);
    assert.equal(wechatOutgoing.content, result.content[0].text);

    await harness.inboundHooks.get('message_sent')?.({
      to: 'owner-user',
      content: wechatOutgoing.content,
      success: true,
      runId,
    }, {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
      runId,
    });
    const afterSuccessfulSend = await harness.inboundHooks.get('message_sending')?.({
      to: 'owner-user',
      content: '普通后续消息',
      metadata: { channel: 'openclaw-weixin', accountId: 'bot-account', runId },
    }, {
      channelId: 'openclaw-weixin',
      accountId: 'bot-account',
    });
    assert.equal(afterSuccessfulSend, undefined);
  } finally {
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
    for (const runId of [firstRunId, secondRunId]) {
      const outgoing = await harness.inboundHooks.get('reply_payload_sending')?.({
        payload: { text: '已记账' },
        kind: 'final',
        channel: 'openclaw-weixin',
        sessionKey: 'agent:main:main',
        runId,
      }, {
        channelId: 'openclaw-weixin',
        sessionKey: 'agent:main:main',
        runId,
      });
      assert.equal(outgoing.payload.text, '这次没记成功，账本里没有新增记录～ 请重新发一条新消息吧。');
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
      '- 账本：[ 日常账本 ]',
      '- 支出：8.25 SGD',
      '- 分类：食品酒水 - 超市购物',
      '- 备注：两根芹菜，一个菜板',
      '- 时间：2026/09/03 16:51',
    ].join('\n'));
    assert.equal(result.details.status, 'created');
    assert.equal(result.details.amountMinor, 825);
    assert.equal(requests.length, 3);
    const receivedSchema = harness.recordExpenseDefinition({}).parameters.anyOf[0];
    assert.equal(receivedSchema.properties.comment.maxLength, 255);
    assert.equal(receivedSchema.required.includes('comment'), false);
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

test('writes the model-resolved occurrence time into both the API and receipt', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));

  try {
    await receiveTrustedOwnerMessage(harness.inboundHooks, {
      content: '记账昨天晚上6点钟，晚餐10.5 备注麦当劳5卤肉饭5.5',
      messageId: 'semantic-time-expense',
      timestamp: 1_788_512_940,
    });
    const result = await harness.recordExpenseFactory(trustedOwnerContext()).execute(
      'semantic-time-record',
      receivedExpenseParams({
        amount: '10.5',
        timeMode: 'explicit',
        localDate: '2026-09-03',
        localTime: '18:00',
        timeEvidence: '昨天晚上6点钟',
      }),
    );

    assert.equal(result.details.status, 'created');
    assert.equal(result.details.timeSource, 'explicit-clock');
    assert.match(result.content[0].text, /- 时间：2026\/09\/03 18:00/u);
    const addRequests = requests.filter(({ url }) => url.endsWith('/transactions/add.json'));
    assert.equal(addRequests.length, 1);
    assert.equal(JSON.parse(addRequests[0].options.body).time, 1_788_429_600);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('confirms a durable semantic-time proposal once after the plugin restarts', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  let firstHarness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));
  let secondHarness;

  try {
    await receiveTrustedOwnerMessage(firstHarness.inboundHooks, {
      content: '昨天晚上6点，晚饭10.5吗',
      messageId: 'ambiguous-expense-time',
      timestamp: 1_788_512_940,
    });
    const prepared = await firstHarness.prepareExpenseFactory(trustedOwnerContext()).execute('prepare-1', {
      amount: '10.5',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
      comment: '晚饭',
      timeMode: 'explicit',
      localDate: '2026-09-03',
      localTime: '18:00',
      timeEvidence: '昨天晚上6点',
    });

    assert.equal(prepared.details.status, 'pending_confirmation');
    assert.equal(prepared.content[0].text, [
      '帮你核对一下这笔～🤔',
      '- 账本：[ 日常账本 ]',
      '- 支出：10.50 SGD',
      '- 分类：食品酒水 - 早午晚餐',
      '- 备注：晚饭',
      '- 时间：2026/09/03 18:00',
      '- 确认：没问题就回复“是”，不记的话回复“不是”就好～',
    ].join('\n'));
    assert.equal(requests.length, 0);

    firstHarness.restore();
    firstHarness = undefined;
    secondHarness = createPluginHarness(tempDirectory, successfulExpenseFetch(requests));

    await receiveTrustedOwnerMessage(secondHarness.inboundHooks, {
      content: '是',
      messageId: 'confirm-expense',
      timestamp: 1_788_513_900,
    });
    const confirmed = await secondHarness.resolveExpenseConfirmationFactory(trustedOwnerContext()).execute(
      'confirm-1',
      { decision: 'confirm' },
    );
    assert.equal(confirmed.details.status, 'created');
    assert.match(confirmed.content[0].text, /时间：2026\/09\/03 18:00/u);
    const addRequest = requests.find(({ url }) => url.endsWith('/transactions/add.json'));
    assert.equal(JSON.parse(addRequest.options.body).time, 1_788_429_600);

    await receiveTrustedOwnerMessage(secondHarness.inboundHooks, {
      content: '是',
      messageId: 'confirm-expense-again',
    });
    const repeated = await secondHarness.resolveExpenseConfirmationFactory(trustedOwnerContext()).execute(
      'confirm-2',
      { decision: 'confirm' },
    );
    assert.equal(repeated.details.status, 'missing');
    assert.equal(repeated.content[0].text, '现在没有等你确认的支出啦～ 放心，我什么都没记 😊');
    assert.equal(requests.filter(({ url }) => url.endsWith('/transactions/add.json')).length, 1);
  } finally {
    secondHarness?.restore();
    firstHarness?.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('resolves a cancellation after transient hook state is lost across plugin instances', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-bookkeeping-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const firstHarness = createPluginHarness(tempDirectory, async () => {
    throw new Error('HTTP must not run for a cancellation');
  });
  let secondHarness;

  try {
    await receiveTrustedOwnerMessage(firstHarness.inboundHooks, {
      content: '午饭8.8么？',
      messageId: 'durable-confirmation-proposal',
    });
    await firstHarness.prepareExpenseFactory(trustedOwnerContext()).execute(
      'durable-confirmation-proposal-call',
      {
        amount: '8.8',
        primaryCategory: '食品酒水',
        subcategory: '早午晚餐',
        comment: '午饭',
      },
    );

    const cancellationRunId = 'run-durable-confirmation-cancel';
    await beginTrustedOwnerTurn(firstHarness.inboundHooks, {
      content: '不是',
      messageId: 'durable-confirmation-cancel',
      runId: cancellationRunId,
    });
    await bindToolCallForTurn(firstHarness.inboundHooks, {
      runId: cancellationRunId,
      toolCallId: 'durable-confirmation-hook-call',
      toolName: 'resolve_expense_confirmation',
      params: { decision: 'cancel' },
    });

    secondHarness = createPluginHarness(tempDirectory, async () => {
      throw new Error('HTTP must not run for a cancellation');
    });
    const cancelled = await secondHarness.rawResolveExpenseConfirmationFactory(
      trustedOwnerContext(),
    ).execute('durable-confirmation-execute-call', { decision: 'cancel' });

    assert.equal(cancelled.details.status, 'cancelled');
    assert.equal(cancelled.content[0].text, '好哒，已经帮你取消啦～ 这笔没有记到账本里 😊');
  } finally {
    secondHarness?.restore();
    firstHarness.restore();
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
    assert.equal(
      mismatch.content[0].text,
      '我还没听明白你是想确认还是取消呢～ 回复“是”我就记上，回复“不是”我就不记 😊',
    );

    await receiveTrustedOwnerMessage(harness.inboundHooks, { content: '不是', messageId: 'cancel-answer' });
    const cancelled = await harness.resolveExpenseConfirmationFactory(trustedOwnerContext()).execute(
      'resolve-cancel',
      { decision: 'cancel' },
    );
    assert.equal(cancelled.details.status, 'cancelled');
    assert.equal(cancelled.content[0].text, '好哒，已经帮你取消啦～ 这笔没有记到账本里 😊');
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
    duplicateText: '这条消息已经处理过啦，我没有重复入账～',
    fetchFailure: undefined,
    expectedRequestCount: 3,
    expectedPostCount: 1,
  },
  {
    name: 'failed',
    firstStatus: 'failed',
    duplicateText: '上次没有记成功，我也没有重复入账～ 请重新发一条消息再试吧。',
    fetchFailure: 'prewrite',
    expectedRequestCount: 1,
    expectedPostCount: 0,
  },
  {
    name: 'unknown',
    firstStatus: 'unknown',
    duplicateText: '这条消息还在处理，或者结果暂时不确定；我没有重复入账哦。',
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

    assert.equal(result.content[0].text, '账本暂时连不上，这次没有写入任何数据～ 稍后再试试吧。');
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

    assert.equal(first.content[0].text, '这次记账结果暂时拿不准，请先看一眼账本，先别重复发送这条消费哦。');
    assert.deepEqual(first.details, { status: 'unknown' });
    assert.equal(retry.content[0].text, '这条消息还在处理，或者结果暂时不确定；我没有重复入账哦。');
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

    assert.equal(result.content[0].text, '账本暂时连不上，这次没有写入任何数据～ 稍后再试试吧。');
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

    assert.equal(result.content[0].text, '这笔金额或语气还不够确定，所以我没有入账哦～');
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

    assert.equal(first.content[0].text, '这次记账结果暂时拿不准，请先看一眼账本，先别重复发送这条消费哦。');
    assert.deepEqual(first.details, { status: 'unknown' });
    assert.equal(replay.content[0].text, '这条消息还在处理，或者结果暂时不确定；我没有重复入账哦。');
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
      '- 账本：[ 日常账本 ]',
      '- 支出：8.25 SGD',
      '- 分类：食品酒水 - 超市购物',
      '- 备注：两根芹菜，一个菜板',
      '- 时间：2026/09/03 16:51',
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

    assert.equal(result.content[0].text, '账本暂时连不上，这次没有写入任何数据～ 稍后再试试吧。');
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

    assert.equal(result.content[0].text, '这次记账结果暂时拿不准，请先看一眼账本，先别重复发送这条消费哦。');
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
