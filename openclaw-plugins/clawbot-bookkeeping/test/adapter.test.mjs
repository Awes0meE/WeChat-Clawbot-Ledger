import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

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

test('trusted inbound queue atomically claims FIFO messages across stores and ignores replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-inbound-queue-'));
  const path = join(dir, 'receipts.sqlite');
  let firstStore;
  let secondStore;
  try {
    firstStore = new SqliteReceiptStore(path);
    secondStore = new SqliteReceiptStore(path);
    const sessionKey = '5d6f5c9f-session-hash';
    const senderKey = '117a4742-sender-hash';
    const firstMessageKey = '19dfd42b-first-message-hash';
    const secondMessageKey = 'ecf7425e-second-message-hash';
    const now = Date.now();
    const firstPayload = { messageId: 'message-1', content: 'first' };
    const secondPayload = { messageId: 'message-2', content: 'second' };

    firstStore.enqueueTrustedInbound(
      [sessionKey, senderKey],
      firstMessageKey,
      firstPayload,
      now + 10_000,
    );
    firstStore.enqueueTrustedInbound(
      [sessionKey, senderKey],
      secondMessageKey,
      secondPayload,
      now + 10_000,
    );

    assert.deepEqual(firstStore.claimTrustedInbound([sessionKey], now), firstPayload);
    firstStore.enqueueTrustedInbound(
      [sessionKey, senderKey],
      firstMessageKey,
      { messageId: 'message-1', content: 'replayed and replaced' },
      now + 20_000,
    );
    assert.deepEqual(secondStore.claimTrustedInbound([senderKey], now), secondPayload);
    assert.equal(firstStore.claimTrustedInbound([sessionKey, senderKey], now), undefined);
  } finally {
    firstStore?.close();
    secondStore?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trusted inbound queue lets only one concurrent store claim a message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-inbound-queue-'));
  const path = join(dir, 'receipts.sqlite');
  let store;
  const workers = [];
  try {
    store = new SqliteReceiptStore(path);
    const now = Date.now();
    const payload = { messageId: 'message-concurrent', content: '午饭7.2' };
    store.enqueueTrustedInbound(
      ['concurrent-lookup-hash'],
      'concurrent-message-hash',
      payload,
      now + 10_000,
    );
    store.close();
    store = undefined;

    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    for (let index = 0; index < 2; index += 1) {
      workers.push(new Worker(new URL('./fixtures/claim-trusted-inbound-worker.mjs', import.meta.url), {
        workerData: { path, lookupKey: 'concurrent-lookup-hash', now, barrier },
      }));
    }
    await Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
      worker.once('message', (message) => message.ready ? resolve() : reject(new Error('worker was not ready')));
      worker.once('error', reject);
    })));
    const results = workers.map((worker) => new Promise((resolve, reject) => {
      worker.once('message', (message) => resolve(message.result));
      worker.once('error', reject);
    }));
    Atomics.store(new Int32Array(barrier), 0, 1);
    Atomics.notify(new Int32Array(barrier), 0, workers.length);

    assert.deepEqual((await Promise.all(results)).filter(Boolean), [payload]);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trusted inbound queue discards expired entries without disturbing receipt history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-inbound-queue-'));
  const path = join(dir, 'receipts.sqlite');
  let store;
  try {
    store = new SqliteReceiptStore(path);
    const now = Date.now();
    store.enqueueTrustedInbound(
      ['lookup-hash'],
      'expired-message-hash',
      { messageId: 'expired' },
      now - 1,
    );
    store.enqueueTrustedInbound(
      ['lookup-hash'],
      'valid-message-hash',
      { messageId: 'valid' },
      now + 10_000,
    );
    assert.equal(store.claim('receipt-history'), null);
    store.complete('receipt-history', { status: 'created', transactionId: 'transaction-history' });

    assert.deepEqual(store.claimTrustedInbound(['lookup-hash'], now), { messageId: 'valid' });
    assert.deepEqual(store.claim('receipt-history'), {
      status: 'created',
      transactionId: 'transaction-history',
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
    }), [{
      time: 1_788_425_460,
      sourceAmount: 825,
      categoryId: 'primary-1',
      categoryName: '食品酒水',
    }]);
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

test('API client encodes keywords and omits undefined expense filters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-api-'));
  const tokenPath = join(dir, 'token.txt');
  writeFileSync(tokenPath, 'secret-test-token', 'utf8');
  let requestUrl;
  const api = new EzBookkeepingApi({
    serverBaseUrl: 'http://127.0.0.1:8180',
    tokenPath,
    fetchImpl: async (url) => {
      requestUrl = new URL(url);
      return new Response(JSON.stringify({ success: true, result: [{
        type: 3,
        categoryId: 'primary-1',
        time: 1_788_425_460,
        sourceAmount: 825,
      }] }), { status: 200 });
    },
  });

  try {
    await api.listExpenseTransactions({ accountId: 'account-1', keyword: '菜+板 & NTUC' });
    assert.equal(requestUrl.searchParams.get('keyword'), '菜+板 & NTUC');
    assert.equal(requestUrl.searchParams.has('category_ids'), false);
    assert.equal(requestUrl.searchParams.has('start_time'), false);
    assert.equal(requestUrl.searchParams.has('end_time'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API client normalizes a blank transaction category name to undefined', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-api-'));
  const tokenPath = join(dir, 'token.txt');
  writeFileSync(tokenPath, 'secret-test-token', 'utf8');
  const api = new EzBookkeepingApi({
    serverBaseUrl: 'http://127.0.0.1:8180',
    tokenPath,
    fetchImpl: async () => new Response(JSON.stringify({ success: true, result: [{
      type: 3,
      categoryId: 'market',
      time: 1_788_425_460,
      sourceAmount: 825,
      category: { name: '   ' },
    }] }), { status: 200 }),
  });

  try {
    assert.deepEqual(await api.listExpenseTransactions({ accountId: 'account-1' }), [{
      time: 1_788_425_460,
      sourceAmount: 825,
      categoryId: 'market',
      categoryName: undefined,
    }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API client rejects malformed expense transaction elements', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-api-'));
  const tokenPath = join(dir, 'token.txt');
  writeFileSync(tokenPath, 'secret-test-token', 'utf8');
  const invalidTransactions = [
    null,
    [],
    { type: 2, categoryId: 'category-1', time: 1_788_425_460, sourceAmount: 825 },
    { type: 3, categoryId: 'category-1', time: 1_788_425_460, sourceAmount: 0 },
    { type: 3, categoryId: 'category-1', time: 1_788_425_460, sourceAmount: 1.5 },
    { type: 3, categoryId: 'category-1', time: 1_788_425_460, sourceAmount: Number.MAX_SAFE_INTEGER + 1 },
    { type: 3, categoryId: 'category-1', time: 0, sourceAmount: 825 },
    { type: 3, categoryId: 'category-1', time: 1.5, sourceAmount: 825 },
    { type: 3, categoryId: '', time: 1_788_425_460, sourceAmount: 825 },
    { type: 3, categoryId: {}, time: 1_788_425_460, sourceAmount: 825 },
    { type: 3, categoryId: 'category-1', time: 1_788_425_460, sourceAmount: 825, category: { name: 123 } },
  ];
  let current;
  const api = new EzBookkeepingApi({
    serverBaseUrl: 'http://127.0.0.1:8180',
    tokenPath,
    fetchImpl: async () => new Response(JSON.stringify({ success: true, result: [current] }), { status: 200 }),
  });

  try {
    for (const transaction of invalidTransactions) {
      current = transaction;
      await assert.rejects(
        () => api.listExpenseTransactions({ accountId: 'account-1' }),
        /expense transaction/i,
      );
    }
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

test('API client preserves hidden categories for historical summary mapping', async () => {
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
    const categories = await api.listExpenseCategories();
    assert.deepEqual(categories, [
      { id: 'primary-visible', name: '食品酒水', parentId: '0', subCategories: [
        { id: 'child-visible', name: '超市购物', parentId: 'primary-visible' },
        { id: 'child-hidden', name: '饮料甜品', parentId: 'primary-visible', hidden: true },
      ] },
      { id: 'primary-hidden', name: '其他杂项', parentId: '0', hidden: true, subCategories: [] },
    ]);
    await assert.rejects(
      () => api.resolveExpenseCategoryFilterId('其他杂项', undefined, categories),
      /expected exactly one expense category/u,
    );
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

test('API client requires a safe bounded integer request timeout', () => {
  for (const requestTimeoutMs of [0, -1, 1.5, 60_001, Number.POSITIVE_INFINITY, '10']) {
    assert.throws(() => new EzBookkeepingApi({
      serverBaseUrl: 'http://127.0.0.1:8180',
      tokenPath: 'ignored',
      requestTimeoutMs,
    }), /timeout/i);
  }
  assert.doesNotThrow(() => new EzBookkeepingApi({
    serverBaseUrl: 'http://127.0.0.1:8180',
    tokenPath: 'ignored',
  }));
  assert.doesNotThrow(() => new EzBookkeepingApi({
    serverBaseUrl: 'http://127.0.0.1:8180',
    tokenPath: 'ignored',
    requestTimeoutMs: 60_000,
  }));
});

test('API client times out when fetch ignores its abort signal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-api-'));
  const tokenPath = join(dir, 'token.txt');
  writeFileSync(tokenPath, 'secret-test-token', 'utf8');
  let signal;
  const api = new EzBookkeepingApi({
    serverBaseUrl: 'http://127.0.0.1:8180',
    tokenPath,
    requestTimeoutMs: 10,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });

  try {
    await assert.rejects(() => api.resolveAccountId('日常支出'), /^Error: ezBookkeeping request timed out$/u);
    assert.equal(signal instanceof AbortSignal, true);
    assert.equal(signal.aborted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API client keeps abort-aware fetch timeout errors free of request secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-api-'));
  const tokenPath = join(dir, 'private-token-file.txt');
  writeFileSync(tokenPath, 'secret-test-token', 'utf8');
  const api = new EzBookkeepingApi({
    serverBaseUrl: 'http://127.0.0.1:8180',
    tokenPath,
    requestTimeoutMs: 10,
    fetchImpl: async (url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(new Error(`aborted ${url} ${options.headers.Authorization} ${options.body ?? ''}`));
      }, { once: true });
    }),
  });

  try {
    await assert.rejects(
      () => api.addTransaction({ comment: 'private-body-marker' }),
      (error) => error instanceof Error
        && error.message === 'ezBookkeeping request timed out'
        && !/secret-test-token|private-body-marker|transactions\/add/u.test(error.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API client clears the request timeout after fetch completes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-api-'));
  const tokenPath = join(dir, 'token.txt');
  writeFileSync(tokenPath, 'secret-test-token', 'utf8');
  let aborted = false;
  const api = new EzBookkeepingApi({
    serverBaseUrl: 'http://127.0.0.1:8180',
    tokenPath,
    requestTimeoutMs: 10,
    fetchImpl: async (_url, options) => {
      options.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Response(JSON.stringify({ success: true, result: [
        { id: 'account-1', name: '日常支出', currency: 'SGD' },
      ] }), { status: 200 });
    },
  });

  try {
    assert.equal(await api.resolveAccountId('日常支出'), 'account-1');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(aborted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API client sanitizes token-file read failures without contacting the server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawbot-api-private-'));
  const tokenPath = join(dir, 'private-token-location.txt');
  let fetchCount = 0;
  const api = new EzBookkeepingApi({
    serverBaseUrl: 'http://127.0.0.1:8180',
    tokenPath,
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error('fetch must not run');
    },
  });

  try {
    await assert.rejects(
      () => api.resolveAccountId('日常支出'),
      (error) => error instanceof Error
        && error.message === 'ezBookkeeping credential unavailable'
        && !error.message.includes(tokenPath)
        && !error.message.includes('private-token-location'),
    );
    assert.equal(fetchCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
