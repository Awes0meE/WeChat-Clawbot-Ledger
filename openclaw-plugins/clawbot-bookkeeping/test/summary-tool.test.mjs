import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import plugin from '../index.ts';

function createPluginHarness(tempDirectory, fetchImpl) {
  const hooks = new Map();
  let summarizeExpensesFactory;
  let summarizeExpensesDefinition;
  const logs = [];
  const pluginApi = {
    pluginConfig: {
      serverBaseUrl: 'http://127.0.0.1:8180',
      tokenPath: join(tempDirectory, 'token.txt'),
      stateDbPath: join(tempDirectory, 'receipts.sqlite'),
      accountName: '日常支出',
    },
    logger: {
      error(message) { logs.push(message); },
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
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  plugin.register(pluginApi);

  return {
    logs,
    summarizeExpensesFactory,
    summarizeExpensesDefinition,
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
      }] }), { status: 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  try {
    const tool = harness.summarizeExpensesFactory(ownerContext());
    const result = await withFixedNow(Date.parse('2026-09-03T16:30:00+08:00'), () => tool.execute(
      'tool-call-summary', { period: 'this_month' },
    ));

    assert.match(result.content[0].text, /^这个月一共花了 8\.25 SGD，共 1 笔 📊/u);
    assert.equal(result.details.status, 'ok');
    assert.equal(result.details.totalAmountMinor, 825);
    assert.equal(requests.filter(({ url }) => new URL(url).pathname.endsWith('/transaction/categories/list.json')).length, 1);
    assert.equal(new URL(requests.at(-1).url).pathname, '/api/v1/transactions/list/all.json');
    assert.equal(harness.summarizeExpensesDefinition({}).parameters.additionalProperties, false);
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
