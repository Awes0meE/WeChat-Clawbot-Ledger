import assert from 'node:assert/strict';
import test from 'node:test';
import { CURRENCY_CODES, CURRENCY_CATALOG, normalizeCurrency, validateExchangeRates, convertCurrencyAmount, exchangeRateDescription } from '../currency.mjs';
import { scopedExpenseAccounts, selectExpenseWriteAccount } from '../expense-accounts.mjs';
import { messageSupportsExpenseAmount, prepareExpenseConfirmation, recordExpense } from '../bookkeeping-core.mjs';
import { parseBankOfChinaSpotSell, fetchBankOfChinaSpotSell, BANK_OF_CHINA_URL } from '../bank-of-china-rates.mjs';
import { answerBookkeepingQuestions, normalizeReadQuestion, questionsFromSummaryParams } from '../bookkeeping-queries.mjs';

const nowMs = Date.parse('2026-09-13T06:00:00+08:00');
const timestamp = Math.floor(nowMs / 1000);
const input = { amount: '35', currency: 'SGD', timeMode: 'received', primaryCategory: '食品酒水', subcategory: '早午晚餐' };
const inbound = { channel: 'synthetic', messageId: 'synthetic', timestamp, content: '午饭35' };
const legacy = { id: 'legacy', name: '日常支出', currency: 'SGD', type: 1 };
const parent = { id: 'parent', name: '多币种支出', currency: '---', type: 2,
  subAccounts: CURRENCY_CODES.map((currency) => ({ id: `sub-${currency}`, parentId: 'parent', type: 1, name: currency, currency })) };
const scoped = scopedExpenseAccounts([legacy, parent, { id: 'private-other', name: '其他账户', currency: 'USD', type: 1 }]);

for (const currency of CURRENCY_CODES) {
  test(`records ${currency} in its original currency subaccount, without needing FX`, async () => {
    const data = CURRENCY_CATALOG[currency];
    for (const label of [currency, currency.toLowerCase(), data.nameZh, data.nameZhHant, data.name]) {
      const matches = CURRENCY_CODES.filter((code) => Object.values(CURRENCY_CATALOG[code]).includes(label));
      if (matches.length > 1) { assert.throws(() => normalizeCurrency(label)); continue; }
      assert.equal(normalizeCurrency(label), currency, label);
      assert.equal(messageSupportsExpenseAmount(`购物35 ${label}`, 3500, currency), true, label);
      assert.equal(messageSupportsExpenseAmount(`购物 ${label} 35`, 3500, currency), true, label);
    }
    const receipt = prepareExpenseConfirmation({ input: { ...input, currency }, inbound: { ...inbound, content: `午饭35${currency}吗` } });
    assert.equal(receipt.amountMinor, 3500);
    let body;
    const api = {
      resolveAccountId: async (name, code) => { assert.equal(name, '日常支出'); return selectExpenseWriteAccount(scoped, code).id; },
      resolveExpenseCategoryId: async () => 'meal',
      addTransaction: async (value) => { body = value; return { id: 'transaction' }; },
      getExchangeRates: async () => assert.fail('original-currency write must not request FX'),
    };
    const store = { claim: () => undefined, complete: () => {}, fail: () => {}, uncertain: () => {} };
    const result = await recordExpense({ api, store, input: { ...input, currency }, inbound: { ...inbound, content: `午饭35${currency}` } });
    assert.equal(result.status, 'created');
    assert.equal(body.sourceAccountId, `sub-${currency}`);
    assert.equal(body.sourceAmount, 3500);
  });
}

test('currency grounding keeps defaults, aliases, quantities and ambiguous markers distinct', () => {
  assert.equal(CURRENCY_CODES.length, 159);
  for (const [content, currency] of [['午饭35', 'SGD'], ['午饭$35', 'SGD'], ['午饭35人民币', 'CNY'], ['午饭35rmb', 'CNY'], ['午饭人民币35', 'CNY'], ['午饭35日元', 'JPY'], ['午饭US$35', 'USD'], ['午饭35，折合人民币是多少', 'SGD']]) {
    assert.equal(messageSupportsExpenseAmount(content, 3500, currency), true, content);
  }
  for (const content of ['午饭¥35', '午饭35ZZZ', '午饭USD35CNY', '午饭35.123CNY', '午饭35人民币，买了2件衣服']) {
    assert.equal(messageSupportsExpenseAmount(content, 3500, 'SGD'), false, content);
  }
  assert.throws(() => prepareExpenseConfirmation({ input, inbound: { ...inbound, content: '午饭35人民币' } }), (e) => e.rejectionReason === 'currency');
  assert.equal(messageSupportsExpenseAmount('买衣服288 puma法拉利F1联名款1件polo衫1件白衬衫', 28800), true);
});

test('account scope excludes unrelated and hidden accounts and refuses ambiguous routing', () => {
  assert.equal(scoped.length, 160);
  assert.equal(selectExpenseWriteAccount(scoped).id, 'sub-SGD');
  assert.equal(selectExpenseWriteAccount(scopedExpenseAccounts([legacy])).id, 'legacy');
  assert.throws(() => selectExpenseWriteAccount(scopedExpenseAccounts([legacy]), 'CNY'));
  for (const accounts of [[legacy, legacy], [{ ...legacy, currency: 'USD' }], [legacy, { ...parent, type: 1 }],
    [legacy, { ...parent, subAccounts: [parent.subAccounts[0], parent.subAccounts[0]] }],
    [legacy, { ...parent, subAccounts: [{ ...parent.subAccounts[0], parentId: 'unrelated' }] }]]) assert.throws(() => scopedExpenseAccounts(accounts));
  assert.equal(scopedExpenseAccounts([legacy, { ...parent, hidden: true }]).length, 1);
});

const headers = ['货币名称', '现汇买入价', '现钞买入价', '现汇卖出价', '现钞卖出价', '中行折算价', '发布日期', '发布时间'];
const row = (name, sell) => [name, '527.32', '510.00', sell, '550.00', '532.20', '2026/09/13 05:30:00', '05:30:00'];
const html = (rows = [row('新加坡元', '531.29'), row('美元', '712.34'), row('新台币', '')], columns = headers) => `<table id="priceTable"><tr>${columns.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
const boc = () => parseBankOfChinaSpotSell(html(), nowMs);

test('BOC uses only spot selling, per 100 foreign units, with exact decimal conversion', () => {
  const fx = boc();
  assert.equal(fx.quotePrices.SGD, '531.29');
  assert.equal(fx.quotePrices.TWD, undefined);
  assert.equal(convertCurrencyAmount(10000, 'SGD', 'CNY', fx), 53129);
  assert.equal(convertCurrencyAmount(53129, 'CNY', 'SGD', fx), 10000);
  assert.equal(convertCurrencyAmount(56110, 'SGD', 'CNY', fx), 298107);
  assert.equal(exchangeRateDescription('SGD', 'CNY', fx), '1 SGD ≈ 5.3129 CNY');
  assert.throws(() => convertCurrencyAmount(100, 'TWD', 'CNY', fx));
  assert.equal(convertCurrencyAmount(3500, 'TWD', 'TWD'), 3500);
  assert.equal(fx.updateTime, Date.parse('2026-09-13T05:30:00+08:00') / 1000);
});

test('BOC official Thai baht name maps to THB spot selling', () => {
  const fx = parseBankOfChinaSpotSell(html([row('泰国铢', '20.36'), row('新台币', '')]), nowMs);
  assert.deepEqual(fx.quotePrices, { THB: '20.36' });
  assert.equal(normalizeCurrency('泰国铢'), 'THB');
  assert.equal(messageSupportsExpenseAmount('午饭35泰国铢', 3500, 'THB'), true);
  assert.equal(convertCurrencyAmount(10000, 'THB', 'CNY', fx), 2036);
});

test('BOC parser fails closed for changed columns, invalid prices/dates or conflicting quotes', () => {
  for (const text of [html([], headers), html([row('新加坡元', 'NaN')]), html([row('新加坡元', '0')]),
    html([row('新加坡元', '531.29'), row('新加坡元', '532')]), html(undefined, headers.map((h) => h === '现汇卖出价' ? '现汇中间价' : h)),
    html().replaceAll('2026/09/13', '2026/02/30'), html().replaceAll('2026/09/13', '2027/09/13')]) {
    assert.throws(() => parseBankOfChinaSpotSell(text, nowMs));
  }
  assert.equal(parseBankOfChinaSpotSell(html(), nowMs + 8 * 86400_000).stale, true);
});

test('public BOC fetch carries no ledger data and never falls back on errors', async () => {
  let calls = 0;
  const fx = await fetchBankOfChinaSpotSell({ nowMs, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, BANK_OF_CHINA_URL);
    assert.deepEqual(options.headers, { Accept: 'text/html' });
    assert.equal(options.redirect, 'error'); assert.equal(options.body, undefined);
    return new Response(html());
  } });
  assert.equal(fx.quotePrices.SGD, '531.29'); assert.equal(calls, 1);
  for (const fetchImpl of [async () => new Response('', { status: 503 }), async () => new Response('<html>blocked</html>'), async () => { throw new Error('private'); }, async () => new Promise(() => {})]) {
    await assert.rejects(fetchBankOfChinaSpotSell({ fetchImpl, nowMs, timeoutMs: 10 }), /^Error: 中国银行现汇卖出价暂时不可用$/u);
  }
});

test('ezBookkeeping provider validates rows and uses exact cross rates', () => {
  const data = { baseCurrency: 'EUR', dataSource: 'European Central Bank', updateTime: timestamp, exchangeRates: [{ currency: 'SGD', rate: '1.4697' }, { currency: 'CNY', rate: '7.7762' }] };
  const fx = validateExchangeRates(data, nowMs);
  assert.equal(convertCurrencyAmount(10000, 'SGD', 'CNY', fx), 52910);
  for (const exchangeRates of [[{ currency: '__proto__', rate: '2' }], [{ currency: 'SGD', rate: '0' }], [{ currency: 'EUR', rate: '2' }], [data.exchangeRates[0], data.exchangeRates[0]]]) assert.throws(() => validateExchangeRates({ ...data, exchangeRates }, nowMs));
});

function queryApi({ failRates = false, rows, failHistory = false } = {}) {
  let calls = 0;
  return {
    get rateCalls() { return calls; },
    listExpenseAccounts: async () => scoped,
    listExpenseCategories: async () => [{ id: 'food', name: '食品酒水', subCategories: [{ id: 'meal', name: '早午晚餐' }] }],
    resolveExpenseCategoryFilterId: async () => undefined,
    listScopedExpenseTransactions: async () => rows ?? [{ type: 3, time: timestamp, sourceAmount: 56110, categoryId: 'meal', currency: 'SGD' }],
    listExpenseHistory: async () => { if (failHistory) throw new Error('private'); return { transactions: [{ time: timestamp, sourceAmount: 3500, currency: 'CNY', categoryId: 'meal', comment: '午饭' }], hasMore: false }; },
    getExchangeRates: async () => { calls++; if (failRates) throw new Error('private'); return boc(); },
  };
}

test('one response answers total, CNY equivalent, history and exchange with one rate snapshot', async () => {
  const api = queryApi();
  const result = await answerBookkeepingQuestions({ api, nowMs, questions: [{ kind: 'summary', period: 'today', convertTo: ['CNY'] }, { kind: 'history' }, { kind: 'exchange', amount: '531.29', fromCurrency: 'CNY', toCurrency: 'SGD' }] });
  assert.equal(result.details.status, 'ok'); assert.equal(result.details.answers.length, 3);
  assert.equal(api.rateCalls, 1);
  for (const text of ['561.10 SGD', '2981.07 CNY', '35.00 CNY', '100.00 SGD', '中国银行 · 现汇卖出价', '05:30']) assert.ok(result.content[0].text.includes(text), text);
});

test('failed FX and independent question failures retain valid original totals', async () => {
  const result = await answerBookkeepingQuestions({ api: queryApi({ failRates: true, failHistory: true }), nowMs,
    questions: [{ kind: 'summary', period: 'today', convertTo: ['CNY'] }, { kind: 'history' }] });
  assert.equal(result.details.status, 'partial');
  assert.match(result.content[0].text, /561\.10 SGD/u);
  assert.match(result.content[0].text, /不能换算/u);
  assert.match(result.content[0].text, /历史查询没有成功/u);
  assert.doesNotMatch(result.content[0].text, /private|0\.00 CNY/u);
});

test('mixed currency summary never labels a partial conversion as a complete total', async () => {
  const api = queryApi({ rows: ['SGD', 'CNY', 'TWD'].map((currency) => ({ type: 3, time: timestamp, sourceAmount: 3500, categoryId: 'meal', currency })) });
  const result = await answerBookkeepingQuestions({ api, nowMs, questions: [{ kind: 'summary', period: 'today', convertTo: ['CNY'] }] });
  assert.equal(result.details.status, 'partial');
  assert.match(result.content[0].text, /缺少 TWD 汇率/u);
  assert.match(result.content[0].text, /中国银行 · 现汇卖出价/u);
  assert.match(result.content[0].text, /2026-09-13 05:30/u);
  assert.doesNotMatch(result.content[0].text, /折合约/u);
});

test('query validation rejects injected account selectors and overlarge batches before any read', async () => {
  for (const q of [{ kind: 'history', accountId: 'unrelated' }, { kind: 'summary', period: 'today', convertTo: ['ZZZ'] }, { kind: 'history', limit: 11 }, { kind: 'find', amount: '35.123' }, { kind: 'exchange', amount: '1', fromCurrency: 'USD', toCurrency: 'ZZZ' }]) assert.throws(() => normalizeReadQuestion(q));
  await assert.rejects(answerBookkeepingQuestions({ api: {}, questions: Array(9).fill({ kind: 'history' }) }));
});


test('WX-153 accepts exact repeated query fields but rejects conflicting scopes', () => {
  const question = { kind: 'summary', period: 'custom', startDate: '2026-09-01', endDate: '2026-09-03' };
  const params = { period: question.period, startDate: question.startDate, endDate: question.endDate, questions: [question] };
  assert.deepEqual(questionsFromSummaryParams(params), [question]);
  assert.throws(() => questionsFromSummaryParams({ ...params, endDate: '2026-09-04' }));
  assert.throws(() => questionsFromSummaryParams({ ...params, questions: [question, question] }));
  assert.throws(() => questionsFromSummaryParams({ ...params, accountId: 'unrelated' }));
});

test('WX-154 infers only the unique formal parent for a read category filter', () => {
  assert.deepEqual(normalizeReadQuestion({ kind: 'summary', period: 'today', subcategory: '早午晚餐' }), {
    kind: 'summary', period: 'today', primaryCategory: '食品酒水', subcategory: '早午晚餐',
  });
  assert.throws(() => normalizeReadQuestion({ kind: 'summary', period: 'today', subcategory: '未定义分类' }));
  assert.throws(() => normalizeReadQuestion({ kind: 'summary', period: 'today', primaryCategory: '衣服饰品', subcategory: '早午晚餐' }));
});
