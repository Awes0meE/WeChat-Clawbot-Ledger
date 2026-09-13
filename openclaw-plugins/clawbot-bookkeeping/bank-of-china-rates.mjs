import { normalizeCurrency, rateFraction } from './currency.mjs';

export const BANK_OF_CHINA_URL = 'https://www.boc.cn/sourcedb/whpj/';
const BANK_NAMES = new Map(Object.entries({
  卢布: 'RUB', 林吉特: 'MYR', 韩国元: 'KRW', 新台币: 'TWD', 泰国铢: 'THB',
  澳门元: 'MOP', 印尼卢比: 'IDR', 越南盾: 'VND', 文莱元: 'BND',
}));
const cellText = (text) => text.replace(/<[^>]*>/gu, '').replace(/&nbsp;|&#160;/giu, ' ').trim();

function quoteTimestamp(date, time) {
  const text = date.includes(':') ? date : `${date} ${time}`;
  const m = text.match(/^(\d{4})[/-](\d{2})[/-](\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/u);
  if (!m) throw new Error('invalid bank quote timestamp');
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  const ms = Date.parse(iso + '+08:00');
  if (!Number.isFinite(ms) || new Date(ms + 8 * 3600_000).toISOString().slice(0, 19) !== iso) {
    throw new Error('invalid bank quote date');
  }
  return ms / 1000;
}

export function parseBankOfChinaSpotSell(html, nowMs = Date.now()) {
  if (typeof html !== 'string' || html.length > 1_000_000) throw new Error('invalid bank response');
  const table = html.match(/<table\b[^>]*\bid=["']priceTable["'][^>]*>([\s\S]*?)<\/table>/iu)?.[1];
  if (!table) throw new Error('bank rate table missing');
  const headers = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/giu)].map((m) => cellText(m[1]));
  const names = ['货币名称', '现汇卖出价', '发布日期', '发布时间'];
  if (names.some((name) => headers.filter((x) => x === name).length !== 1)) throw new Error('bank rate table columns changed');
  const positions = names.map((name) => headers.indexOf(name));
  const quotes = new Map();
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)].map((m) => cellText(m[1]));
    if (!cells.length) continue;
    if (cells.length !== headers.length) throw new Error('incomplete bank quote row');
    const [name, sell, date, time] = positions.map((position) => cells[position]);
    if (sell === '' || sell === '-') continue; // Never substitute cash selling or middle rates.
    let currency;
    try { currency = BANK_NAMES.get(name) ?? normalizeCurrency(name); } catch { continue; }
    rateFraction(sell);
    const updatedAt = quoteTimestamp(date, time);
    if (updatedAt * 1000 > nowMs + 300_000) throw new Error('bank quote is in the future');
    const previous = quotes.get(currency);
    if (previous?.updatedAt === updatedAt && previous.sell !== sell) throw new Error('conflicting bank quotes');
    if (!previous || updatedAt > previous.updatedAt) quotes.set(currency, { sell, updatedAt });
  }
  if (!quotes.size) throw new Error('no bank spot selling quotes');
  const updateTime = Math.min(...[...quotes.values()].map((q) => q.updatedAt));
  return {
    baseCurrency: 'CNY', dataSource: '中国银行 · 现汇卖出价', updateTime,
    referenceUrl: BANK_OF_CHINA_URL,
    quotePrices: Object.fromEntries([...quotes].map(([code, q]) => [code, q.sell])),
    quoteUpdateTimes: Object.fromEntries([...quotes].map(([code, q]) => [code, q.updatedAt])),
    stale: nowMs - updateTime * 1000 > 7 * 24 * 3600_000,
  };
}

export async function fetchBankOfChinaSpotSell({ fetchImpl = globalThis.fetch, timeoutMs = 10_000, nowMs = Date.now() } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('bank rate request timed out')); }, timeoutMs);
  });
  try {
    // This is a public quote request. No ledger credential, user ID, amount,
    // query text, or transaction data is sent to the bank.
    const response = await Promise.race([fetchImpl(BANK_OF_CHINA_URL, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'text/html' },
    }), timeout]);
    if (!response.ok || Number(response.headers.get('content-length') ?? '0') > 1_000_000) throw new Error('bank response unavailable');
    return parseBankOfChinaSpotSell(await Promise.race([response.text(), timeout]), nowMs);
  } catch { throw new Error('中国银行现汇卖出价暂时不可用'); }
  finally { clearTimeout(timer); }
}

export function validateBankOfChinaSnapshot(value, nowMs = Date.now()) {
  if (!value || value.baseCurrency !== 'CNY' || value.dataSource !== '中国银行 · 现汇卖出价'
    || value.referenceUrl !== BANK_OF_CHINA_URL || !value.quotePrices || !value.quoteUpdateTimes
    || Array.isArray(value.quotePrices) || Object.keys(value.quotePrices).length > 159) throw new Error('invalid cached bank quote');
  const quotePrices = {}, quoteUpdateTimes = {};
  for (const [code, price] of Object.entries(value.quotePrices)) {
    if (normalizeCurrency(code) !== code || code === 'CNY') throw new Error('invalid bank currency');
    rateFraction(price);
    const time = value.quoteUpdateTimes[code];
    if (!Number.isSafeInteger(time) || time <= 0 || time * 1000 > nowMs + 300_000) throw new Error('invalid bank timestamp');
    quotePrices[code] = price; quoteUpdateTimes[code] = time;
  }
  if (!Object.keys(quotePrices).length) throw new Error('empty cached quotes');
  const updateTime = Math.min(...Object.values(quoteUpdateTimes));
  return { baseCurrency: 'CNY', dataSource: '中国银行 · 现汇卖出价', referenceUrl: BANK_OF_CHINA_URL,
    quotePrices, quoteUpdateTimes, updateTime, stale: nowMs - updateTime * 1000 > 7 * 86400_000 };
}
