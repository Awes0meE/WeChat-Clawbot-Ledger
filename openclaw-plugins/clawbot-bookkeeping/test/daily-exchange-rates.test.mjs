import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DailyBankOfChinaRates, millisecondsUntilSingaporeMidnight } from '../daily-exchange-rates.mjs';
import { BANK_OF_CHINA_URL } from '../bank-of-china-rates.mjs';
import { exchangeRateSourceText } from '../currency.mjs';

const initial = Date.parse('2026-09-13T23:59:50+08:00');
const quote = (now) => ({ baseCurrency: 'CNY', dataSource: '中国银行 · 现汇卖出价', referenceUrl: BANK_OF_CHINA_URL,
  quotePrices: { SGD: '531.29' }, quoteUpdateTimes: { SGD: Math.floor(now / 1000) } });

test('Singapore midnight schedule fires once daily and catches up after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-daily-fx-'));
  let now = initial, loads = 0, scheduled, cancelled;
  const options = { path: join(directory, 'rates.sqlite'), now: () => now,
    load: async () => { loads++; return quote(now); },
    schedule: (callback, delay) => { scheduled = { callback, delay }; return 'synthetic-timer'; }, cancel: (id) => { cancelled = id; } };
  let cache = new DailyBankOfChinaRates(options);
  try {
    cache.start(); await cache.get();
    assert.equal(loads, 1); assert.equal(scheduled.delay, 10000);
    await cache.get(); await cache.get(); assert.equal(loads, 1);
    now += 10000; scheduled.callback(); await cache.get();
    assert.equal(loads, 2); assert.equal(scheduled.delay, 86400_000);
    cache.close(); assert.equal(cancelled, 'synthetic-timer');
    cache = new DailyBankOfChinaRates(options); cache.start(); await cache.get();
    assert.equal(loads, 2, 'restart must reuse the current day snapshot');
    cache.close(); now += 2 * 86400_000;
    cache = new DailyBankOfChinaRates(options); cache.start(); await cache.get();
    assert.equal(loads, 3, 'missed days require one catch-up, not replaying every missed day');
  } finally { cache.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a failed day retains successful quotes, labels fallback and does not poll repeatedly', async () => {
  let now = initial, fail = false, loads = 0;
  const cache = new DailyBankOfChinaRates({ path: ':memory:', now: () => now,
    load: async () => { loads++; if (fail) throw new Error('private'); return quote(now); } });
  try {
    await cache.get(); fail = true; now += 86400_000;
    const fallback = await cache.get();
    assert.equal(fallback.quotePrices.SGD, '531.29'); assert.equal(fallback.refreshFailed, true);
    assert.match(exchangeRateSourceText(fallback), /今日更新未成功，使用上次成功报价/u);
    await cache.get(); await cache.get(); assert.equal(loads, 2);
    fail = false; now += 86400_000;
    assert.equal((await cache.get()).refreshFailed, false); assert.equal(loads, 3);
  } finally { cache.close(); }
});

test('separate plugin instances share one daily claim and stored snapshot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-daily-fx-'));
  let loads = 0;
  const options = { path: join(directory, 'rates.sqlite'), now: () => initial,
    load: async () => { loads++; return quote(initial); } };
  const a = new DailyBankOfChinaRates(options), b = new DailyBankOfChinaRates(options);
  try { await a.get(); assert.deepEqual(await b.get(), await a.get()); assert.equal(loads, 1); }
  finally { a.close(); b.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('first fetch failure cannot invent a quote and closed services do not retain timers', async () => {
  let loads = 0;
  const cache = new DailyBankOfChinaRates({ path: ':memory:', now: () => initial,
    load: async () => { loads++; throw new Error('private'); } });
  try { await assert.rejects(cache.get()); await assert.rejects(cache.get()); assert.equal(loads, 1); }
  finally { cache.close(); cache.close(); }
  assert.equal(millisecondsUntilSingaporeMidnight(Date.parse('2026-09-13T00:00:00+08:00')), 86400_000);
});
