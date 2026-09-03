import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EzBookkeepingApi, SqliteReceiptStore } from '../adapter.mjs';

test('SQLite receipt claims are atomic and durable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-receipts-'));
  const path = join(dir, 'receipts.sqlite');
  try {
    const first = new SqliteReceiptStore(path);
    assert.equal(first.claim('ilink:message-1'), null);
    first.complete('ilink:message-1', { status: 'created', transactionId: 'tx-1' });
    first.close();

    const reopened = new SqliteReceiptStore(path);
    assert.deepEqual(reopened.claim('ilink:message-1'), {
      status: 'created',
      transactionId: 'tx-1',
    });
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite receipt store retains an uncertain write outcome for deduplication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-receipts-'));
  const path = join(dir, 'receipts.sqlite');
  let store;
  try {
    store = new SqliteReceiptStore(path);
    assert.equal(store.claim('ilink:message-uncertain'), null);
    store.uncertain('ilink:message-uncertain', {
      status: 'failed',
      clientSessionId: 'session-1',
    });
    assert.deepEqual(store.claim('ilink:message-uncertain'), {
      status: 'unknown',
      clientSessionId: 'session-1',
    });
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API client resolves the exact SGD account and category hierarchy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-api-'));
  const tokenPath = join(dir, 'token.txt');
  writeFileSync(tokenPath, 'secret-test-token', 'utf8');
  const requests = [];
  const fakeFetch = async (url, options) => {
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
    throw new Error(`unexpected URL: ${url}`);
  };

  try {
    const api = new EzBookkeepingApi({
      serverBaseUrl: 'http://127.0.0.1:8180',
      tokenPath,
      fetchImpl: fakeFetch,
    });
    assert.equal(await api.resolveAccountId('日常支出'), 'account-1');
    assert.equal(await api.resolveExpenseCategoryId('食品酒水', '超市购物'), 'secondary-1');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer secret-test-token');
    assert.equal(requests[0].options.headers['X-Timezone-Name'], 'Asia/Singapore');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API client lists filtered expense transactions through the documented read endpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-api-'));
  const tokenPath = join(dir, 'token.txt');
  writeFileSync(tokenPath, 'secret-test-token', 'utf8');
  const requests = [];
  const transaction = {
    id: 'transaction-1',
    type: 3,
    categoryId: 'primary-1',
    time: 1_788_425_460,
    sourceAccountId: 'account-1',
    sourceAmount: 825,
    category: { id: 'primary-1', name: '食品酒水', parentId: '0' },
    comment: 'NTUC',
  };
  const fakeFetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ success: true, result: [transaction] }), { status: 200 });
  };

  try {
    const api = new EzBookkeepingApi({
      serverBaseUrl: 'http://127.0.0.1:8180',
      tokenPath,
      fetchImpl: fakeFetch,
    });
    assert.deepEqual(await api.listExpenseTransactions({
      accountId: 'account-1',
      startTime: 1_788_192_000,
      endTime: 1_790_783_999,
      categoryId: 'primary-1',
      keyword: 'NTUC',
    }), [transaction]);
    assert.equal(typeof requests[0].url, 'string');
    const url = new URL(requests[0].url);
    assert.equal(url.pathname, '/api/v1/transactions/list/all.json');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      type: '3',
      account_ids: 'account-1',
      category_ids: 'primary-1',
      start_time: '1788192000',
      end_time: '1790783999',
      keyword: 'NTUC',
      trim_account: 'true',
      trim_tag: 'true',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API client resolves visible expense category filters from a preloaded hierarchy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-api-'));
  const tokenPath = join(dir, 'token.txt');
  writeFileSync(tokenPath, 'secret-test-token', 'utf8');
  const categories = [{ id: 'primary-1', name: '食品酒水', parentId: '0', subCategories: [
    { id: 'secondary-1', name: '超市购物', parentId: 'primary-1' },
  ] }];
  const api = new EzBookkeepingApi({
    serverBaseUrl: 'http://127.0.0.1:8180',
    tokenPath,
    fetchImpl: async () => { throw new Error('fetch should not be called'); },
  });

  try {
    assert.equal(await api.resolveExpenseCategoryFilterId(undefined, undefined, categories), undefined);
    assert.equal(await api.resolveExpenseCategoryFilterId('食品酒水', undefined, categories), 'primary-1');
    assert.equal(await api.resolveExpenseCategoryFilterId('食品酒水', '超市购物', categories), 'secondary-1');
    await assert.rejects(
      () => api.resolveExpenseCategoryFilterId('食品酒水', '不存在', categories),
      /expected exactly one subcategory/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API client omits hidden categories from the expense hierarchy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-api-'));
  const tokenPath = join(dir, 'token.txt');
  writeFileSync(tokenPath, 'secret-test-token', 'utf8');
  const api = new EzBookkeepingApi({
    serverBaseUrl: 'http://127.0.0.1:8180',
    tokenPath,
    fetchImpl: async () => new Response(JSON.stringify({ success: true, result: {
      2: [
        { id: 'primary-visible', name: '食品酒水', parentId: '0', subCategories: [
          { id: 'child-visible', name: '超市购物', parentId: 'primary-visible' },
          { id: 'child-hidden', name: '饮料甜品', parentId: 'primary-visible', hidden: true },
        ] },
        { id: 'primary-hidden', name: '其他杂项', parentId: '0', hidden: true, subCategories: [] },
      ],
    } }), { status: 200 }),
  });

  try {
    assert.deepEqual(await api.listExpenseCategories(), [
      { id: 'primary-visible', name: '食品酒水', parentId: '0', subCategories: [
        { id: 'child-visible', name: '超市购物', parentId: 'primary-visible' },
      ] },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API client rejects malformed category and transaction list results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-api-'));
  const tokenPath = join(dir, 'token.txt');
  writeFileSync(tokenPath, 'secret-test-token', 'utf8');
  let request = 0;
  const api = new EzBookkeepingApi({
    serverBaseUrl: 'http://127.0.0.1:8180',
    tokenPath,
    fetchImpl: async () => {
      request += 1;
      return new Response(JSON.stringify({ success: true, result: request === 1 ? {} : {} }), { status: 200 });
    },
  });

  try {
    await assert.rejects(() => api.listExpenseCategories(), /expense category list/i);
    await assert.rejects(() => api.listExpenseTransactions({ accountId: 'account-1' }), /expense transaction list/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API client refuses non-loopback bookkeeping servers', () => {
  assert.throws(() => new EzBookkeepingApi({
    serverBaseUrl: 'https://example.com',
    tokenPath: 'ignored',
  }), /loopback/i);
});
