import assert from 'node:assert/strict';
import test from 'node:test';

import {
  duplicateResponseText,
  extractVerbatimComment,
  normalizeMessageTimestamp,
  parseAmountToMinorUnits,
  recordExpense,
} from '../bookkeeping-core.mjs';

test('parses SGD amounts into integer minor units', () => {
  assert.equal(parseAmountToMinorUnits('12.8'), 1280);
  assert.equal(parseAmountToMinorUnits('2'), 200);
  assert.equal(parseAmountToMinorUnits('8.25'), 825);
  assert.throws(() => parseAmountToMinorUnits('1.234'));
  assert.throws(() => parseAmountToMinorUnits('0'));
});

test('extracts only the verbatim text after the first 备注 delimiter', () => {
  assert.equal(
    extractVerbatimComment('NTUC购物8.25，备注买了两根芹菜，一个菜板'),
    '买了两根芹菜，一个菜板',
  );
  assert.equal(extractVerbatimComment('午饭12.8'), '');
  assert.equal(extractVerbatimComment('咖啡3，备注少糖  不加冰'), '少糖  不加冰');
});

test('rejects comments longer than ezBookkeeping supports', () => {
  assert.throws(() => extractVerbatimComment(`测试1，备注${'字'.repeat(256)}`));
});

test('normalizes second and millisecond event timestamps', () => {
  assert.equal(normalizeMessageTimestamp(1_788_425_460), 1_788_425_460);
  assert.equal(normalizeMessageTimestamp(1_788_425_460_000), 1_788_425_460);
});

test('records one expense and preserves trusted message metadata', async () => {
  const calls = [];
  const receipts = new Map();
  const api = {
    async resolveAccountId(name) {
      assert.equal(name, '日常支出');
      return 'account-1';
    },
    async resolveExpenseCategoryId(primary, secondary) {
      assert.equal(primary, '食品酒水');
      assert.equal(secondary, '超市购物');
      return 'category-1';
    },
    async addTransaction(body) {
      calls.push(body);
      return { id: 'transaction-1' };
    },
  };
  const store = {
    claim(key) {
      if (receipts.has(key)) return receipts.get(key);
      const value = { status: 'pending' };
      receipts.set(key, value);
      return null;
    },
    complete(key, value) {
      receipts.set(key, value);
    },
    fail(key, value) {
      receipts.set(key, value);
    },
  };

  const result = await recordExpense({
    api,
    store,
    input: {
      amount: '8.25',
      primaryCategory: '食品酒水',
      subcategory: '超市购物',
    },
    inbound: {
      channel: 'ilink',
      messageId: 'wechat-message-1',
      content: 'NTUC购物8.25，备注买了两根芹菜，一个菜板',
      timestamp: 1_788_425_460_000,
    },
  });

  assert.equal(result.status, 'created');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    type: 3,
    categoryId: 'category-1',
    time: 1_788_425_460,
    utcOffset: 480,
    sourceAccountId: 'account-1',
    sourceAmount: 825,
    destinationAccountId: '0',
    destinationAmount: 0,
    hideAmount: false,
    tagIds: [],
    pictureIds: [],
    comment: '买了两根芹菜，一个菜板',
    clientSessionId: result.clientSessionId,
  });
});

test('deduplicates the same message id but not identical text from a new message', async () => {
  let addCount = 0;
  const receipts = new Map();
  const store = {
    claim(key) {
      if (receipts.has(key)) return receipts.get(key);
      receipts.set(key, { status: 'pending' });
      return null;
    },
    complete(key, value) {
      receipts.set(key, value);
    },
    fail(key, value) {
      receipts.set(key, value);
    },
  };
  const api = {
    async resolveAccountId() { return 'account-1'; },
    async resolveExpenseCategoryId() { return 'category-1'; },
    async addTransaction() {
      addCount += 1;
      return { id: `transaction-${addCount}` };
    },
  };
  const input = { amount: '12.8', primaryCategory: '食品酒水', subcategory: '早午晚餐' };
  const baseInbound = {
    channel: 'ilink',
    content: '午饭12.8',
    timestamp: 1_788_383_892_000,
  };

  const first = await recordExpense({ api, store, input, inbound: { ...baseInbound, messageId: 'msg-a' } });
  const replay = await recordExpense({ api, store, input, inbound: { ...baseInbound, messageId: 'msg-a' } });
  const distinct = await recordExpense({ api, store, input, inbound: { ...baseInbound, messageId: 'msg-b' } });

  assert.equal(first.status, 'created');
  assert.equal(replay.status, 'duplicate');
  assert.equal(distinct.status, 'created');
  assert.equal(addCount, 2);
});

test('refuses to write without a trusted inbound message id', async () => {
  await assert.rejects(() => recordExpense({
    api: {},
    store: {},
    input: { amount: '2', primaryCategory: '食品酒水', subcategory: '饮料甜品' },
    inbound: { channel: 'ilink', content: '橙汁2', timestamp: Date.now() },
  }), /message id/i);
});

test('duplicate replies distinguish confirmed, failed, and uncertain prior attempts', () => {
  assert.equal(
    duplicateResponseText({ previousStatus: 'created' }),
    '同一条微信消息已处理，未重复入账。',
  );
  assert.equal(
    duplicateResponseText({ previousStatus: 'failed' }),
    '上一处理尝试失败，未重复入账；请重新发送一条消息重试。',
  );
  assert.equal(
    duplicateResponseText({ previousStatus: 'pending' }),
    '同一条微信消息正在处理或状态未确认，未重复入账。',
  );
});
