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

test('API client refuses non-loopback bookkeeping servers', () => {
  assert.throws(() => new EzBookkeepingApi({
    serverBaseUrl: 'https://example.com',
    tokenPath: 'ignored',
  }), /loopback/i);
});
