import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import plugin from '../index.ts';

function createPluginHarness(tempDirectory, fetchImpl, pluginConfig = {}) {
  const hooks = new Map();
  let summarizeExpensesFactory;
  let summarizeExpensesDefinition;
  let mcpServerConnectionResolver;
  const logs = [];
  const pluginApi = {
    pluginConfig: {
      serverBaseUrl: 'http://127.0.0.1:8180',
      tokenPath: join(tempDirectory, 'token.txt'),
      mcpTokenPath: join(tempDirectory, 'mcp-token.txt'),
      stateDbPath: join(tempDirectory, 'receipts.sqlite'),
      accountName: '日常支出',
      ...pluginConfig,
    },
    logger: {
      error(message) { logs.push(message); },
    },
    config: {
      commands: { ownerAllowFrom: ['openclaw-weixin:alice'] },
    },
    on(name, handler) {
      hooks.set(name, handler);
    },
    registerTool(definition, options) {
      if (typeof definition === 'function' && options?.name === 'summarize_expenses') {
        summarizeExpensesFactory = definition;
        summarizeExpensesDefinition = definition;
      }
    },
    registerMcpServerConnectionResolver(resolver) {
      mcpServerConnectionResolver = resolver;
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  plugin.register(pluginApi);

  return {
    logs,
    summarizeExpensesFactory,
    summarizeExpensesDefinition,
    mcpServerConnectionResolver,
    restore() {
      hooks.get('gateway_stop')?.({}, {});
      globalThis.fetch = originalFetch;
    },
  };
}

function ownerContext() {
  return { senderIsOwner: true };
}

function nonOwnerContext() {
  return { senderIsOwner: false };
}

async function withFixedNow(nowMs, action) {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return await action();
  } finally {
    Date.now = originalNow;
  }
}

test('declares the owner-only expense summary tool in the plugin manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.contracts.tools, [
    'bookkeeping_health',
    'record_expense',
    'summarize_expenses',
  ]);
  assert.deepEqual(manifest.toolMetadata.summarize_expenses, { profiles: ['minimal'] });
  assert.deepEqual(manifest.configSchema.properties.requestTimeoutMs, {
    type: 'integer',
    minimum: 1,
    maximum: 60000,
    default: 10000,
  });
});

test('registers only the requester-scoped read-only ezBookkeeping MCP resolver', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-summary-'));
  const harness = createPluginHarness(tempDirectory, async () => { throw new Error('fetch must not run'); });
  try {
    assert.equal(harness.mcpServerConnectionResolver.serverName, 'ezbookkeeping');
    const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
    assert.deepEqual(manifest.mcpServers.ezbookkeeping.toolFilter.include, ['query_transactions']);
    assert.equal(manifest.mcpServers.ezbookkeeping.toolFilter.include.includes('add_transaction'), false);
    assert.equal(await harness.mcpServerConnectionResolver.resolve({
      messageChannel: 'openclaw-weixin',
      requesterSenderId: 'stranger',
    }), null);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('uses separate strict schemas for natural and custom summary periods', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-summary-'));
  const harness = createPluginHarness(tempDirectory, async () => { throw new Error('fetch must not run'); });

  try {
    const schema = harness.summarizeExpensesDefinition({}).parameters;
    assert.equal(schema.anyOf.length, 2);
    const natural = schema.anyOf.find((branch) => branch.properties.startDate === undefined);
    const custom = schema.anyOf.find((branch) => branch.properties.startDate !== undefined);
    assert.equal(natural.additionalProperties, false);
    assert.equal(natural.properties.keyword.maxLength, 100);
    assert.deepEqual(custom.required.sort(), ['endDate', 'period', 'startDate']);
    assert.equal(custom.properties.startDate.pattern, '^\\d{4}-\\d{2}-\\d{2}$');
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('rejects non-owners before reading a token or contacting the ledger', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-summary-'));
  let fetchCount = 0;
  const harness = createPluginHarness(tempDirectory, async () => {
    fetchCount += 1;
    throw new Error('fetch must not run');
  });

  try {
    const tool = harness.summarizeExpensesFactory(nonOwnerContext());
    await assert.rejects(() => tool.execute('tool-call-owner', { period: 'this_month' }), /owner/i);
    assert.equal(fetchCount, 0);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('returns an authoritative owner expense summary for this month', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-summary-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, async (url, options) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/accounts/list.json')) {
      return new Response(JSON.stringify({ success: true, result: [
        { id: 'account-1', name: '日常支出', currency: 'SGD', hidden: false },
      ] }), { status: 200 });
    }
    if (pathname.endsWith('/transaction/categories/list.json')) {
      return new Response(JSON.stringify({ success: true, result: {
        2: [{ id: 'primary-1', name: '食品酒水', parentId: '0', hidden: false, subCategories: [
          { id: 'secondary-1', name: '超市购物', parentId: 'primary-1', hidden: false },
        ] }],
      } }), { status: 200 });
    }
    if (pathname.endsWith('/transactions/list/all.json')) {
      return new Response(JSON.stringify({ success: true, result: [{
        id: 'transaction-1',
        type: 3,
        categoryId: 'secondary-1',
        time: 1_788_425_460,
        sourceAccountId: 'account-1',
        sourceAmount: 825,
        category: { id: 'secondary-1', name: '超市购物', parentId: 'primary-1' },
        comment: 'NTUC',
        arbitraryPayload: 'arbitrary-payload-marker',
      }] }), { status: 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  try {
    const tool = harness.summarizeExpensesFactory(ownerContext());
    const result = await withFixedNow(Date.parse('2026-09-03T16:30:00+08:00'), () => tool.execute(
      'tool-call-summary', {
        period: 'this_month',
        primaryCategory: '食品酒水',
        subcategory: '超市购物',
        keyword: '菜+板 & NTUC',
      },
    ));

    assert.match(result.content[0].text, /^这个月一共花了 8\.25 SGD，共 1 笔 📊/u);
    assert.equal(result.details.status, 'ok');
    assert.equal(result.details.totalAmountMinor, 825);
    assert.equal(requests.filter(({ url }) => new URL(url).pathname.endsWith('/accounts/list.json')).length, 1);
    assert.equal(requests.filter(({ url }) => new URL(url).pathname.endsWith('/transaction/categories/list.json')).length, 1);
    assert.equal(requests.filter(({ url }) => new URL(url).pathname.endsWith('/transactions/list/all.json')).length, 1);
    const transactionRequest = new URL(requests.at(-1).url);
    assert.equal(transactionRequest.pathname, '/api/v1/transactions/list/all.json');
    assert.equal(transactionRequest.searchParams.get('category_ids'), 'secondary-1');
    assert.equal(transactionRequest.searchParams.get('keyword'), '菜+板 & NTUC');
    const serializedDetails = JSON.stringify(result.details);
    assert.equal(/comment|sourceAccountId|transaction-1|account-1|NTUC|arbitrary-payload-marker/u.test(serializedDetails), false);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('uses hidden categories for truthful historical mapping and keeps unknown ids separate', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-summary-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/accounts/list.json')) {
      return new Response(JSON.stringify({ success: true, result: [
        { id: 'account-1', name: '日常支出', currency: 'SGD' },
      ] }), { status: 200 });
    }
    if (pathname.endsWith('/transaction/categories/list.json')) {
      return new Response(JSON.stringify({ success: true, result: {
        2: [
          { id: 'hidden-primary', name: '居家物业', parentId: '0', hidden: true, subCategories: [] },
          { id: 'visible-primary', name: '食品酒水', parentId: '0', subCategories: [
            { id: 'hidden-child', name: '饮料甜品', parentId: 'visible-primary', hidden: true },
          ] },
          { id: 'real-other', name: '其他杂项', parentId: '0', subCategories: [] },
        ],
      } }), { status: 200 });
    }
    if (pathname.endsWith('/transactions/list/all.json')) {
      return new Response(JSON.stringify({ success: true, result: [
        { type: 3, categoryId: 'hidden-primary', time: 1_788_100_000, sourceAmount: 100 },
        { type: 3, categoryId: 'hidden-child', time: 1_788_200_000, sourceAmount: 200 },
        { type: 3, categoryId: 'real-other', time: 1_788_300_000, sourceAmount: 300 },
        { type: 3, categoryId: 'deleted', time: 1_788_400_000, sourceAmount: 400 },
      ] }), { status: 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  try {
    const result = await harness.summarizeExpensesFactory(ownerContext()).execute('tool-call-history', { period: 'this_month' });
    assert.deepEqual(result.details.categories, [
      { name: '未识别分类', amountMinor: 400 },
      { name: '其他杂项', amountMinor: 300 },
      { name: '食品酒水', amountMinor: 200 },
      { name: '居家物业', amountMinor: 100 },
    ]);
    assert.deepEqual(result.details.largest[0], {
      time: 1_788_400_000,
      amountMinor: 400,
      categoryName: '未识别分类',
    });
    assert.deepEqual(result.details.largest.map((item) => item.categoryName), [
      '未识别分类', '其他杂项', '饮料甜品',
    ]);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('rejects a blank summary keyword before reading a token or contacting the ledger', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-summary-'));
  let requestCount = 0;
  const harness = createPluginHarness(tempDirectory, async () => {
    requestCount += 1;
    throw new Error('fetch must not run');
  });

  try {
    await assert.rejects(
      () => harness.summarizeExpensesFactory(ownerContext()).execute('tool-call-blank-keyword', {
        period: 'this_month', keyword: '   ',
      }),
      /关键词/u,
    );
    assert.equal(requestCount, 0);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('uses a visible primary category id without duplicate reads for a primary-only filter', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-summary-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const requests = [];
  const harness = createPluginHarness(tempDirectory, async (url) => {
    requests.push(new URL(url));
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/accounts/list.json')) {
      return new Response(JSON.stringify({ success: true, result: [{ id: 'account-1', name: '日常支出', currency: 'SGD' }] }), { status: 200 });
    }
    if (pathname.endsWith('/transaction/categories/list.json')) {
      return new Response(JSON.stringify({ success: true, result: {
        2: [{ id: 'primary-1', name: '食品酒水', parentId: '0', subCategories: [] }],
      } }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
  });

  try {
    const result = await harness.summarizeExpensesFactory(ownerContext()).execute('tool-call-primary-filter', {
      period: 'this_month', primaryCategory: '食品酒水',
    });
    assert.equal(result.details.status, 'ok');
    assert.equal(requests.filter((url) => url.pathname.endsWith('/accounts/list.json')).length, 1);
    assert.equal(requests.filter((url) => url.pathname.endsWith('/transaction/categories/list.json')).length, 1);
    const transactionRequests = requests.filter((url) => url.pathname.endsWith('/transactions/list/all.json'));
    assert.equal(transactionRequests.length, 1);
    assert.equal(transactionRequests[0].searchParams.get('category_ids'), 'primary-1');
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('returns a stable failure without sensitive ledger details when a read fails', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-summary-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async () => {
    throw new Error('connection refused with token test-token and transaction secret');
  });

  try {
    const tool = harness.summarizeExpensesFactory(ownerContext());
    const result = await tool.execute('tool-call-read-failure', { period: 'this_month' });
    assert.equal(result.content[0].text, '账本暂时连不上，本次没有读取任何数据，请稍后再试。');
    assert.deepEqual(result.details, { status: 'failed' });
    assert.equal(harness.logs.some((entry) => /test-token|transaction secret/u.test(entry)), false);
    assert.match(harness.logs[0], /Error/u);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('returns the stable no-data failure when an expense summary request times out', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-summary-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  let requestCount = 0;
  const harness = createPluginHarness(tempDirectory, async () => {
    requestCount += 1;
    return new Promise(() => {});
  }, { requestTimeoutMs: 10 });

  try {
    const startedAt = Date.now();
    const result = await harness.summarizeExpensesFactory(ownerContext()).execute(
      'tool-call-read-timeout',
      { period: 'this_month' },
    );
    assert.equal(result.content[0].text, '账本暂时连不上，本次没有读取任何数据，请稍后再试。');
    assert.deepEqual(result.details, { status: 'failed' });
    assert.equal(requestCount, 1);
    assert.match(harness.logs[0], /Error/u);
    assert.doesNotMatch(harness.logs[0], /token|accounts\/list/u);
    assert.equal(Date.now() - startedAt < 500, true);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('turns a malformed transaction response into the same stable read failure', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-summary-'));
  writeFileSync(join(tempDirectory, 'token.txt'), 'test-token', 'utf8');
  const harness = createPluginHarness(tempDirectory, async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/accounts/list.json')) {
      return new Response(JSON.stringify({ success: true, result: [{ id: 'account-1', name: '日常支出', currency: 'SGD' }] }), { status: 200 });
    }
    if (pathname.endsWith('/transaction/categories/list.json')) {
      return new Response(JSON.stringify({ success: true, result: { 2: [] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, result: [{
      type: 2, categoryId: 'bad', time: 1_788_425_460, sourceAmount: 825, comment: 'sensitive comment',
    }] }), { status: 200 });
  });

  try {
    const result = await harness.summarizeExpensesFactory(ownerContext()).execute('tool-call-malformed', { period: 'this_month' });
    assert.equal(result.content[0].text, '账本暂时连不上，本次没有读取任何数据，请稍后再试。');
    assert.deepEqual(result.details, { status: 'failed' });
    assert.equal(harness.logs.some((entry) => /sensitive comment/u.test(entry)), false);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('rejects invalid summary filters before treating them as a ledger failure', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'clawbot-summary-'));
  let fetchCount = 0;
  const harness = createPluginHarness(tempDirectory, async () => {
    fetchCount += 1;
    throw new Error('fetch must not run');
  });

  try {
    const tool = harness.summarizeExpensesFactory(ownerContext());
    await assert.rejects(
      () => tool.execute('tool-call-invalid-date', {
        period: 'custom', startDate: '2026-02-29', endDate: '2026-03-01',
      }),
      /custom date is invalid/u,
    );
    await assert.rejects(
      () => tool.execute('tool-call-invalid-category', {
        period: 'this_month', primaryCategory: '食品酒水', subcategory: '数码装备',
      }),
      /二级分类/u,
    );
    assert.equal(fetchCount, 0);
  } finally {
    harness.restore();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
