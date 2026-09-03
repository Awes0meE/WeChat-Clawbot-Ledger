import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateExpenseSummary,
  formatExpenseSummary,
  resolveExpenseRange,
} from '../expense-summary.mjs';

const nowMs = Date.parse('2026-09-03T16:30:00+08:00');

test('resolves Singapore calendar periods to inclusive Unix-second boundaries', () => {
  assert.deepEqual(resolveExpenseRange({ period: 'this_month' }, nowMs), {
    label: '这个月',
    startTime: 1_788_192_000,
    endTime: 1_790_783_999,
  });
  assert.deepEqual(resolveExpenseRange({
    period: 'custom',
    startDate: '2026-08-30',
    endDate: '2026-09-02',
  }, nowMs), {
    label: '2026/08/30–2026/09/02',
    startTime: 1_788_019_200,
    endTime: 1_788_364_799,
  });
});

test('rejects impossible or reversed custom calendar ranges', () => {
  assert.throws(
    () => resolveExpenseRange({ period: 'custom', startDate: '2026-02-29', endDate: '2026-03-01' }, nowMs),
    /custom date is invalid/u,
  );
  assert.throws(
    () => resolveExpenseRange({ period: 'custom', startDate: '2026-09-03', endDate: '2026-09-02' }, nowMs),
    /custom date range must not be reversed/u,
  );
});

test('aggregates integer amounts by primary category and selects the largest three', () => {
  const summary = aggregateExpenseSummary([
    { time: 1_788_300_000, sourceAmount: 720, categoryId: 'meal', categoryName: '早午晚餐' },
    { time: 1_788_200_000, sourceAmount: 825, categoryId: 'market', categoryName: '超市购物' },
    { time: 1_788_100_000, sourceAmount: 2400, categoryId: 'digital', categoryName: '数码装备' },
    { time: 1_788_000_000, sourceAmount: 250, categoryId: 'drink', categoryName: '饮料甜品' },
  ], new Map([
    ['meal', '食品酒水'], ['market', '食品酒水'],
    ['digital', '学习进修'], ['drink', '食品酒水'],
  ]));

  assert.equal(summary.totalAmountMinor, 4195);
  assert.equal(summary.count, 4);
  assert.deepEqual(summary.categories, [
    { name: '学习进修', amountMinor: 2400 },
    { name: '食品酒水', amountMinor: 1795 },
  ]);
  assert.deepEqual(summary.largest, [
    { time: 1_788_100_000, amountMinor: 2400, categoryName: '数码装备' },
    { time: 1_788_200_000, amountMinor: 825, categoryName: '超市购物' },
    { time: 1_788_300_000, amountMinor: 720, categoryName: '早午晚餐' },
  ]);
});

test('rejects zero, negative, or fractional transaction amounts', () => {
  const categories = new Map([['meal', '食品酒水']]);
  assert.throws(
    () => aggregateExpenseSummary([{ sourceAmount: 0, categoryId: 'meal' }], categories),
    /transaction amount is invalid/u,
  );
  assert.throws(
    () => aggregateExpenseSummary([{ sourceAmount: -1, categoryId: 'meal' }], categories),
    /transaction amount is invalid/u,
  );
  assert.throws(
    () => aggregateExpenseSummary([{ sourceAmount: 1.5, categoryId: 'meal' }], categories),
    /transaction amount is invalid/u,
  );
});

test('keeps transactions unchanged and breaks equal largest amounts by later time', () => {
  const transactions = [
    { time: 1_788_100_000, sourceAmount: 500, categoryId: 'meal', categoryName: '早午晚餐' },
    { time: 1_788_200_000, sourceAmount: 500, categoryId: 'meal', categoryName: '早午晚餐' },
  ];
  const originalTransactions = structuredClone(transactions);

  const summary = aggregateExpenseSummary(transactions, new Map([['meal', '食品酒水']]));

  assert.deepEqual(summary.largest.map((item) => item.time), [1_788_200_000, 1_788_100_000]);
  assert.deepEqual(transactions, originalTransactions);
});

test('keeps hidden and real other categories distinct from unknown deleted category ids', () => {
  const summary = aggregateExpenseSummary([
    { time: 1_788_100_000, sourceAmount: 100, categoryId: 'hidden-primary' },
    { time: 1_788_200_000, sourceAmount: 200, categoryId: 'hidden-child' },
    { time: 1_788_300_000, sourceAmount: 300, categoryId: 'real-other' },
    { time: 1_788_400_000, sourceAmount: 400, categoryId: 'deleted' },
  ], new Map([
    ['hidden-primary', '居家物业'],
    ['hidden-child', '食品酒水'],
    ['real-other', '其他杂项'],
  ]), new Map([
    ['hidden-primary', '房租'],
    ['hidden-child', '饮料甜品'],
    ['real-other', '其他支出'],
  ]));

  assert.deepEqual(summary.categories, [
    { name: '未识别分类', amountMinor: 400 },
    { name: '其他杂项', amountMinor: 300 },
    { name: '食品酒水', amountMinor: 200 },
    { name: '居家物业', amountMinor: 100 },
  ]);
  assert.deepEqual(summary.largest[0], {
    time: 1_788_400_000,
    amountMinor: 400,
    categoryName: '未识别分类',
  });
});

test('uses the hierarchy category name when a sanitized transaction name is blank', () => {
  const summary = aggregateExpenseSummary([
    { time: 1_788_100_000, sourceAmount: 825, categoryId: 'market', categoryName: undefined },
  ], new Map([['market', '食品酒水']]), new Map([['market', '超市购物']]));

  assert.match(formatExpenseSummary('这个月', summary), /- 🏆 最大三笔\n  - 08\/30 超市购物：8\.25 SGD/u);
});

test('rejects transactions whose accumulated summary total is unsafe', () => {
  const categories = new Map([['large', '食品酒水'], ['one', '食品酒水']]);
  assert.throws(
    () => aggregateExpenseSummary([
      { sourceAmount: Number.MAX_SAFE_INTEGER, categoryId: 'large' },
      { sourceAmount: 1, categoryId: 'one' },
    ], categories),
    /transaction summary total is unsafe/u,
  );
});

test('formats a category breakdown and the three largest expenses', () => {
  const summary = {
    totalAmountMinor: 4195,
    count: 4,
    categories: [{ name: '学习进修', amountMinor: 2400 }, { name: '食品酒水', amountMinor: 1795 }],
    largest: [
      { time: 1_788_100_000, amountMinor: 2400, categoryName: '数码装备' },
      { time: 1_788_200_000, amountMinor: 825, categoryName: '超市购物' },
      { time: 1_788_300_000, amountMinor: 720, categoryName: '早午晚餐' },
    ],
  };
  const formatted = formatExpenseSummary('这个月', summary);

  assert.match(formatted, /^这个月一共花了 41\.95 SGD，共 4 笔 📊/u);
  assert.match(formatted, /- 📂 分类汇总\n  - 学习进修：24\.00 SGD\n  - 食品酒水：17\.95 SGD/u);
  assert.match(formatted, /- 🏆 最大三笔\n  - 08\/30 数码装备：24\.00 SGD/u);
  assert.equal(formatExpenseSummary('这个月', {
    totalAmountMinor: 0, count: 0, categories: [], largest: [],
  }), '这个月还没有支出记录哦～');
});

test('formats large safe integer cent amounts exactly', () => {
  const formatted = formatExpenseSummary('这个月', {
    totalAmountMinor: 9_007_199_254_740_990,
    count: 1,
    categories: [{ name: '食品酒水', amountMinor: 9_007_199_254_740_990 }],
    largest: [],
  });

  assert.equal(formatted.split('\n')[0], '这个月一共花了 90071992547409.90 SGD，共 1 笔 📊');
});
