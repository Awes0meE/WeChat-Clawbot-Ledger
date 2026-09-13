import { readFileSync } from 'node:fs';

// Facts pinned to the deployed ezBookkeeping version; provenance is in the JSON.
export const CURRENCY_CATALOG = Object.freeze(JSON.parse(readFileSync(new URL('./currency-catalog.json', import.meta.url), 'utf8')).currencies);
export const CURRENCY_CODES = Object.freeze(Object.keys(CURRENCY_CATALOG));
export const MULTICURRENCY_ACCOUNT_NAME = '多币种支出';
const aliases = new Map();
for (const [code, info] of Object.entries(CURRENCY_CATALOG)) {
  for (const name of [code, info.name, info.nameZh, info.nameZhHant]) {
    const key = name.toUpperCase();
    aliases.set(key, aliases.has(key) && aliases.get(key) !== code ? null : code);
  }
}
for (const [code, names] of Object.entries({
  SGD: ['新币', '新幣', '新元', '坡币', '坡幣', 'S$'],
  CNY: ['RMB', '人民币', '人民幣'], USD: ['美元', '美金', 'US$'],
  HKD: ['港币', '港幣', '港元', 'HK$'], JPY: ['日元', '日币', '日幣'],
  EUR: ['欧元', '歐元', '€'], GBP: ['英镑', '英鎊'],
  MYR: ['马币', '馬幣', '令吉', 'RM'], TWD: ['台币', '台幣', '新台币', 'NT$'],
  AUD: ['澳元', '澳币', '澳幣', 'A$'], CAD: ['加元', '加币', '加幣'],
  KRW: ['韩元', '韓元', '韩币', '韓幣'], THB: ['泰铢', '泰銖', '泰国铢', '泰國銖'],
})) for (const name of names) aliases.set(name.toUpperCase(), code);

export function normalizeCurrency(value) {
  const code = aliases.get(String(value ?? '').trim().toUpperCase());
  if (!code) throw new Error('unsupported or ambiguous currency');
  return code;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const aliasSource = [...aliases.keys()].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
const prefixCurrency = new RegExp(`(?<![A-Za-z])(${aliasSource})\\s*$`, 'iu');
const suffixCurrency = new RegExp(`^\\s*(${aliasSource})(?![A-Za-z])`, 'iu');

export function hasNegativeAmountPrefix(prefix) {
  const text = String(prefix);
  const marker = text.match(prefixCurrency);
  const before = marker ? text.slice(0, marker.index) : text;
  return /[-−－负負]\s*(?:\p{Sc}\s*)?$/u.test(before);
}

export function startsWithCurrency(value) { return suffixCurrency.test(value); }

// Currency belongs to the amount beside it, not a later requested conversion.
export function currencyBesideAmount(prefix, suffix) {
  const left = String(prefix).match(prefixCurrency)?.[1];
  const right = String(suffix).match(suffixCurrency)?.[1];
  if (left || right) {
    const a = left ? normalizeCurrency(left) : undefined;
    const b = right ? normalizeCurrency(right) : undefined;
    if (a && b && a !== b) throw new Error('conflicting currency declarations');
    return a ?? b;
  }
  // A bare dollar sign follows the local SGD default. Yen/yuan symbols are
  // shared, and unsupported three-letter declarations must never become SGD.
  if (/[¥￥€£₩]\s*$/u.test(prefix) || /^\s*[¥￥€£₩]/u.test(suffix)
    || /(?:^|\s)[A-Z]{3}\s*$/u.test(prefix)
    || /^\s*[A-Z]{3}(?![A-Za-z])/u.test(suffix)) {
    throw new Error('currency declaration needs clarification');
  }
  return 'SGD';
}

export function formatCurrencyAmount(amountMinor, currency = 'SGD') {
  currency = normalizeCurrency(currency);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error('invalid currency amount');
  const n = BigInt(amountMinor);
  return `${n / 100n}.${(n % 100n).toString().padStart(2, '0')} ${currency}`;
}

export function rateFraction(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^(?:0|[1-9]\d*)(?:\.\d{1,32})?$/u.test(value)) {
    throw new Error('invalid exchange rate');
  }
  const [whole, fraction = ''] = value.split('.');
  const numerator = BigInt(whole + fraction);
  if (numerator <= 0n) throw new Error('non-positive exchange rate');
  return [numerator, 10n ** BigInt(fraction.length)];
}

function rateForCurrency(rates, currency) {
  if (rates.quotePrices) {
    if (currency === 'CNY') return [1n, 1n];
    const [n, d] = rateFraction(rates.quotePrices[currency]);
    return [100n * d, n];
  }
  return rateFraction(rates.rates[currency]);
}

export function validateExchangeRates(data, nowMs = Date.now()) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !Object.hasOwn(CURRENCY_CATALOG, data.baseCurrency)
    || typeof data.dataSource !== 'string' || !data.dataSource.trim() || data.dataSource.length > 120
    || /[\p{C}\p{Zl}\p{Zp}]/u.test(data.dataSource)
    || !Number.isSafeInteger(data.updateTime) || data.updateTime <= 0
    || data.updateTime * 1000 > nowMs + 300_000
    || !Array.isArray(data.exchangeRates) || data.exchangeRates.length > 500) {
    throw new Error('invalid exchange rate response');
  }
  const rates = {};
  for (const row of data.exchangeRates) {
    if (!row || !Object.hasOwn(CURRENCY_CATALOG, row.currency) || Object.hasOwn(rates, row.currency)) throw new Error('duplicate or invalid rate');
    rateFraction(row.rate);
    rates[row.currency] = row.rate;
  }
  if (Object.hasOwn(rates, data.baseCurrency)) {
    const [n, d] = rateFraction(rates[data.baseCurrency]);
    if (n !== d) throw new Error('base currency rate must be one');
  }
  rates[data.baseCurrency] = '1';
  return { baseCurrency: data.baseCurrency, dataSource: data.dataSource, updateTime: data.updateTime,
    rates, stale: nowMs - data.updateTime * 1000 > 7 * 24 * 60 * 60 * 1000 };
}

export function convertCurrencyAmount(amountMinor, fromCurrency, toCurrency, rates) {
  fromCurrency = normalizeCurrency(fromCurrency);
  toCurrency = normalizeCurrency(toCurrency);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error('invalid conversion amount');
  if (fromCurrency === toCurrency) return amountMinor;
  const [fn, fd] = rateForCurrency(rates, fromCurrency);
  const [tn, td] = rateForCurrency(rates, toCurrency);
  const numerator = BigInt(amountMinor) * tn * fd;
  const denominator = td * fn;
  // Exact decimal arithmetic, rounded once to the platform's 1/100 units.
  const rounded = (2n * numerator + denominator) / (2n * denominator);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('converted amount is unsafe');
  return Number(rounded);
}

export function exchangeRateDescription(fromCurrency, toCurrency, rates) {
  const [fn, fd] = rateForCurrency(rates, normalizeCurrency(fromCurrency));
  const [tn, td] = rateForCurrency(rates, normalizeCurrency(toCurrency));
  const scale = 100_000_000n;
  const n = (2n * tn * fd * scale + td * fn) / (2n * td * fn);
  const value = `${n / scale}.${(n % scale).toString().padStart(8, '0')}`.replace(/0+$/u, '').replace(/\.$/u, '');
  return `1 ${fromCurrency} ≈ ${value || '0'} ${toCurrency}`;
}

export function exchangeRateSourceText(rates) {
  const time = new Date((rates.updateTime + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ');
  return `汇率来源：${rates.dataSource}；更新于 ${time}（新加坡时间）${rates.dailySnapshot ? '；每日 00:00 取价' : ''}${rates.refreshFailed ? '；今日更新未成功，使用上次成功报价' : ''}${rates.stale ? '；数据已超过 7 天，仅供估算' : ''}`;
}
