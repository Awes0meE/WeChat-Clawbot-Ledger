import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EzBookkeepingApi } from '../adapter.mjs';

const BASE_TIME = 1_788_425_460;
const SEARCH = { accountId: 'account-1', amountMinor: 336 };

function transaction(overrides = {}) {
  const time = overrides.time ?? BASE_TIME;
  return {
    id: 'transaction-1',
    timeSequenceId: `${BigInt(time) * 1000n + 1n}`,
    type: 3,
    categoryId: 'category-1',
    category: { name: '饮料甜品' },
    time,
    sourceAccountId: SEARCH.accountId,
    sourceAmount: SEARCH.amountMinor,
    comment: '合成饮品备注',
    ...overrides,
  };
}

function createApi(t, result, { success = true, status = 200 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-amount-search-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenPath = join(directory, 'token.txt');
  writeFileSync(tokenPath, 'synthetic-test-token', 'utf8');
  const requests = [];
  const api = new EzBookkeepingApi({
    serverBaseUrl: 'http://127.0.0.1:8888',
    tokenPath,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return new Response(JSON.stringify({ success, result }), { status });
    },
  });
  return { api, requests };
}

test('finds exact minor-unit expenses across all history using one bounded GET', async (t) => {
  const row = transaction();
  const { api, requests } = createApi(t, { items: [row], nextTimeSequenceId: null });
  assert.deepEqual(await api.findExpenseTransactions(SEARCH), {
    transactions: [{
      time: BASE_TIME,
      sourceAmount: 336,
      categoryId: 'category-1',
      categoryName: '饮料甜品',
      comment: '合成饮品备注',
    }],
    hasMore: false,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.pathname, '/api/v1/transactions/list.json');
  assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), {
    type: '3', account_ids: 'account-1', amount_filter: 'eq:336',
    max_time: '0', page: '1', count: '4', trim_account: 'true', trim_tag: 'true',
  });
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(Object.hasOwn(requests[0].options, 'body'), false);
});

test('converts inclusive Unix-second bounds to transaction sequence bounds', async (t) => {
  const { api, requests } = createApi(t, {
    items: [transaction({ id: 'end', time: BASE_TIME + 1 }), transaction()],
    nextTimeSequenceId: null,
  });
  const found = await api.findExpenseTransactions({
    ...SEARCH, startTime: BASE_TIME, endTime: BASE_TIME + 1, limit: 10,
  });
  assert.equal(requests[0].url.searchParams.get('min_time'), `${BASE_TIME * 1000}`);
  assert.equal(requests[0].url.searchParams.get('max_time'), `${(BASE_TIME + 1) * 1000 + 999}`);
  assert.equal(requests[0].url.searchParams.get('count'), '11');
  assert.deepEqual(found.transactions.map((row) => row.time), [BASE_TIME + 1, BASE_TIME]);
  assert.equal(found.hasMore, false);
});

test('sorts newest first including same-second sequence order before limiting', async (t) => {
  const rows = [
    transaction({ id: 'old', time: BASE_TIME - 1, comment: 'old' }),
    transaction({ id: 'same-first', comment: 'same-first' }),
    transaction({ id: 'same-last', timeSequenceId: `${BigInt(BASE_TIME) * 1000n + 999n}`, comment: 'same-last' }),
    transaction({ id: 'new', time: BASE_TIME + 1, comment: 'new' }),
  ];
  const { api, requests } = createApi(t, { items: rows, nextTimeSequenceId: null });
  const result = await api.findExpenseTransactions(SEARCH);
  assert.deepEqual(result.transactions.map((row) => row.comment), ['new', 'same-last', 'same-first']);
  assert.equal(result.hasMore, true);
  assert.equal(requests.length, 1);
  for (const row of result.transactions) {
    assert.equal(Object.hasOwn(row, 'id'), false);
    assert.equal(Object.hasOwn(row, 'sourceAccountId'), false);
    assert.equal(Object.hasOwn(row, 'timeSequenceId'), false);
  }
});

test('preserves hasMore for a short page with a valid cursor without fetching again', async (t) => {
  const { api, requests } = createApi(t, {
    items: [transaction()], nextTimeSequenceId: `${BigInt(BASE_TIME - 1) * 1000n}`,
  });
  const result = await api.findExpenseTransactions(SEARCH);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.hasMore, true);
  assert.equal(requests.length, 1);
});

test('accepts an empty complete result and an omitted optional category object', async (t) => {
  const empty = createApi(t, { items: [], nextTimeSequenceId: null });
  assert.deepEqual(await empty.api.findExpenseTransactions(SEARCH), { transactions: [], hasMore: false });
  const bare = createApi(t, { items: [transaction({ category: undefined, comment: '' })], nextTimeSequenceId: null });
  const result = await bare.api.findExpenseTransactions(SEARCH);
  assert.equal(result.transactions[0].categoryName, undefined);
  assert.equal(result.transactions[0].comment, '');
});

for (const [name, input] of [
  ['missing account', { accountId: undefined }],
  ['blank account', { accountId: ' ' }],
  ['padded account', { accountId: ' account-1' }],
  ['non-string account', { accountId: 1 }],
  ['all-account sentinel', { accountId: '0' }],
  ['multiple account ids', { accountId: 'account-1,account-2' }],
  ['zero amount', { amountMinor: 0 }],
  ['negative amount', { amountMinor: -1 }],
  ['fractional amount', { amountMinor: 3.36 }],
  ['string amount', { amountMinor: '336' }],
  ['unsafe amount', { amountMinor: Number.MAX_SAFE_INTEGER + 1 }],
  ['zero limit', { limit: 0 }],
  ['excess limit', { limit: 11 }],
  ['fractional limit', { limit: 1.5 }],
  ['string limit', { limit: '3' }],
  ['negative start', { startTime: -1 }],
  ['fractional end', { endTime: BASE_TIME + 0.1 }],
  ['unsafe sequence bound', { endTime: Number.MAX_SAFE_INTEGER }],
  ['reversed bounds', { startTime: BASE_TIME + 1, endTime: BASE_TIME }],
]) {
  test(`rejects ${name} before reading a credential or invoking fetch`, async () => {
    let fetched = false;
    const api = new EzBookkeepingApi({
      serverBaseUrl: 'http://127.0.0.1:8888',
      tokenPath: 'intentionally-missing-synthetic-token',
      fetchImpl: async () => { fetched = true; throw new Error('fetch must not run'); },
    });
    await assert.rejects(() => api.findExpenseTransactions({ ...SEARCH, ...input }), /expense search/i);
    assert.equal(fetched, false);
  });
}

for (const [name, row] of [
  ['null row', null],
  ['array row', []],
  ['income', transaction({ type: 2 })],
  ['another account', transaction({ sourceAccountId: 'other-account' })],
  ['missing account', transaction({ sourceAccountId: undefined })],
  ['another amount', transaction({ sourceAmount: 337 })],
  ['fractional amount', transaction({ sourceAmount: 336.1 })],
  ['string amount', transaction({ sourceAmount: '336' })],
  ['missing id', transaction({ id: undefined })],
  ['blank id', transaction({ id: ' ' })],
  ['non-string id', transaction({ id: 42 })],
  ['missing sequence id', transaction({ timeSequenceId: undefined })],
  ['numeric sequence id', transaction({ timeSequenceId: BASE_TIME * 1000 })],
  ['invalid sequence id', transaction({ timeSequenceId: 'not-a-sequence' })],
  ['sequence mismatching time', transaction({ timeSequenceId: `${BigInt(BASE_TIME + 1) * 1000n}` })],
  ['missing comment', transaction({ comment: undefined })],
  ['non-string comment', transaction({ comment: {} })],
  ['oversized comment', transaction({ comment: '字'.repeat(256) })],
  ['missing category id', transaction({ categoryId: undefined })],
  ['invalid category name', transaction({ category: { name: 4 } })],
  ['before requested range', transaction({ time: BASE_TIME - 1 })],
  ['after requested range', transaction({ time: BASE_TIME + 1 })],
]) {
  test(`fails closed on ${name}`, async (t) => {
    const { api, requests } = createApi(t, { items: [row], nextTimeSequenceId: null });
    await assert.rejects(() => api.findExpenseTransactions({
      ...SEARCH, startTime: BASE_TIME, endTime: BASE_TIME,
    }), /expense search/i);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.method, 'GET');
  });
}

for (const [name, result] of [
  ['null result', null],
  ['bare array', []],
  ['missing items', {}],
  ['non-array items', { items: {}, nextTimeSequenceId: null }],
  ['missing cursor field', { items: [] }],
  ['numeric cursor', { items: [transaction()], nextTimeSequenceId: 42 }],
  ['invalid cursor', { items: [transaction()], nextTimeSequenceId: 'invalid' }],
  ['cursor newer than page', { items: [transaction()], nextTimeSequenceId: `${BigInt(BASE_TIME + 1) * 1000n}` }],
  ['empty incomplete page', { items: [], nextTimeSequenceId: `${BigInt(BASE_TIME) * 1000n}` }],
  ['duplicate transaction id', { items: [transaction(), transaction()], nextTimeSequenceId: null }],
  ['more than requested count', { items: Array.from({ length: 5 }, (_, index) => transaction({ id: `row-${index}` })), nextTimeSequenceId: null }],
]) {
  test(`fails closed on ${name}`, async (t) => {
    const { api, requests } = createApi(t, result);
    await assert.rejects(() => api.findExpenseTransactions(SEARCH), /expense search/i);
    assert.equal(requests.length, 1);
  });
}

test('validates the lookahead row even though it will not be returned', async (t) => {
  const { api } = createApi(t, {
    items: [transaction(), transaction({ id: 'wrong-lookahead', sourceAccountId: 'other-account' })],
    nextTimeSequenceId: null,
  });
  await assert.rejects(() => api.findExpenseTransactions({ ...SEARCH, limit: 1 }), /expense search/i);
});

test('does not convert a failed HTTP result into a no-match answer', async (t) => {
  const { api } = createApi(t, { items: [], nextTimeSequenceId: null }, { success: false });
  await assert.rejects(() => api.findExpenseTransactions(SEARCH), /request failed/i);
});
