import { parseAmountToMinorUnits } from './bookkeeping-core.mjs';
import { resolveExpenseRange } from './expense-summary.mjs';

const PARAMETER_KEYS = new Set(['amount', 'currency', 'period', 'startDate', 'endDate', 'limit']);
const PERIODS = new Set(['all', 'today', 'this_week', 'this_month', 'last_month', 'this_year', 'custom']);
const SINGAPORE_OFFSET_MS = 8 * 60 * 60 * 1000;

export function resolveExpenseSearch(params, nowMs = Date.now()) {
  if (!params || typeof params !== 'object' || Array.isArray(params)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(params))
    || Reflect.ownKeys(params).some((key) => !PARAMETER_KEYS.has(key))) {
    throw new Error('expense search parameters are invalid');
  }
  if (typeof params.amount !== 'string' || params.amount.trim() !== params.amount) {
    throw new Error('expense search amount must be a decimal string');
  }
  const amountMinor = parseAmountToMinorUnits(params.amount);
  if (params.currency !== 'SGD') throw new Error('expense search currency must be SGD');

  const limit = params.limit === undefined ? 3 : params.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error('expense search limit must be an integer from 1 to 10');
  }
  const period = params.period === undefined ? 'all' : params.period;
  if (!PERIODS.has(period)) throw new Error('unsupported expense search period');
  if (period !== 'custom' && (Object.hasOwn(params, 'startDate') || Object.hasOwn(params, 'endDate'))) {
    throw new Error('expense search dates require a custom period');
  }
  if (period === 'all') return { amountMinor, limit, label: '全部历史' };
  if (period === 'custom') {
    for (const date of [params.startDate, params.endDate]) {
      if (typeof date !== 'string' || date.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
        throw new Error('expense search custom dates must use YYYY-MM-DD');
      }
    }
  }
  if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) {
    throw new Error('expense search current date is invalid');
  }
  return { amountMinor, limit, ...resolveExpenseRange({ ...params, period }, nowMs) };
}

function formatMinor(amountMinor) {
  const amount = BigInt(amountMinor);
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')} SGD`;
}

function displayData(value) {
  return String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .trim()
    // Escape every ASCII punctuation character accepted by Markdown backslash escaping.
    .replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/gu, '\\$&');
}

function formatSingaporeTime(time) {
  if (!Number.isSafeInteger(time) || time <= 0) throw new Error('expense search result time is invalid');
  const date = new Date(time * 1000 + SINGAPORE_OFFSET_MS);
  if (!Number.isFinite(date.getTime())) throw new Error('expense search result time is invalid');
  const twoDigits = (number) => String(number).padStart(2, '0');
  return `${String(date.getUTCFullYear()).padStart(4, '0')}/${twoDigits(date.getUTCMonth() + 1)}/${twoDigits(date.getUTCDate())}`
    + ` ${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}`;
}

export function formatExpenseSearch(query, { transactions, hasMore }, categoryNameById = new Map()) {
  if (!Number.isSafeInteger(query.amountMinor) || query.amountMinor <= 0
    || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 10
    || typeof query.label !== 'string' || !query.label.trim()
    || !Array.isArray(transactions) || typeof hasMore !== 'boolean'
    || (transactions.length === 0 && hasMore)) {
    throw new Error('expense search result is invalid');
  }
  const amount = formatMinor(query.amountMinor);
  const lines = [
    '日常账本 · SGD 支出查询',
    `- 单笔金额：精确匹配 ${amount}`,
    `- 查询范围：${query.label}`,
  ];
  if (transactions.length === 0) {
    return [...lines, `该范围内没有单笔金额为 ${amount} 的支出记录。`].join('\n');
  }
  const displayed = transactions.slice(0, query.limit);
  for (const [index, transaction] of displayed.entries()) {
    if (!transaction || transaction.sourceAmount !== query.amountMinor) {
      throw new Error('expense search result amount does not match');
    }
    const category = displayData(transaction.categoryName)
      || displayData(categoryNameById.get(String(transaction.categoryId)))
      || '未识别分类';
    const comment = displayData(transaction.comment) || '无';
    lines.push(`${index + 1}. ${formatSingaporeTime(transaction.time)}｜${amount}｜分类：${category}｜备注：${comment}`);
  }
  if (hasMore || transactions.length > displayed.length) {
    lines.push(`还有更多匹配，这里只列最近 ${displayed.length} 笔。`);
  }
  return lines.join('\n');
}
