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
    { id: '1', time: 1_788_300_000, sourceAmount: 720, categoryId: 'meal', category: { name: '早午晚餐' }, comment: '' },
    { id: '2', time: 1_788_200_000, sourceAmount: 825, categoryId: 'market', category: { name: '超市购物' }, comment: '两根芹菜，一个菜板' },
    { id: '3', time: 1_788_100_000, sourceAmount: 2400, categoryId: 'digital', category: { name: '数码装备' }, comment: '网线' },
    { id: '4', time: 1_788_000_000, sourceAmount: 250, categoryId: 'drink', category: { name: '饮料甜品' }, comment: '' },
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
  assert.deepEqual(summary.largest.map((item) => item.id), ['3', '2', '1']);
});

test('rejects negative or fractional transaction amounts', () => {
  const categories = new Map([['meal', '食品酒水']]);
  assert.throws(
    () => aggregateExpenseSummary([{ sourceAmount: -1, categoryId: 'meal' }], categories),
    /transaction amount is invalid/u,
  );
  assert.throws(
    () => aggregateExpenseSummary([{ sourceAmount: 1.5, categoryId: 'meal' }], categories),
    /transaction amount is invalid/u,
  );
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
      { id: '3', time: 1_788_100_000, sourceAmount: 2400, category: { name: '数码装备' } },
      { id: '2', time: 1_788_200_000, sourceAmount: 825, category: { name: '超市购物' } },
      { id: '1', time: 1_788_300_000, sourceAmount: 720, category: { name: '早午晚餐' } },
    ],
  };
  const formatted = formatExpenseSummary('这个月', summary);

  assert.match(formatted, /^这个月一共花了 41\.95 SGD，共 4 笔 📊/u);
  assert.match(formatted, /分类汇总：\n学习进修：24\.00 SGD\n食品酒水：17\.95 SGD/u);
  assert.match(formatted, /最大三笔：\n08\/30 数码装备：24\.00 SGD/u);
  assert.equal(formatExpenseSummary('这个月', {
    totalAmountMinor: 0, count: 0, categories: [], largest: [],
  }), '这个月还没有支出记录～');
});
