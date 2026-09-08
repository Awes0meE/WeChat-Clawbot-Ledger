import { parseAmountToMinorUnits } from './bookkeeping-core.mjs';

export const HISTORY_TOOL_NAME = 'ezbookkeeping__query_transactions';
export const HISTORY_FAILURE_TEXT = '这次没有取得可靠的支出明细，请稍后再查一下吧～';
const DISPLAY_FIELDS = 'time,currency,category_name,account_name,comment';
const SINGAPORE_OFFSET_MS = 8 * 60 * 60 * 1000;

function timestamp(value) {
  if (typeof value !== 'string') throw new Error('history timestamp is invalid');
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) throw new Error('history timestamp is invalid');
  const [year, month, day] = match.slice(1, 4).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const offsetHour = Number(match[9] ?? 0);
  const offsetMinute = Number(match[10] ?? 0);
  const milliseconds = Date.parse(value);
  if (year < 1970 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month
    || calendar.getUTCDate() !== day || offsetHour > 14 || offsetMinute > 59
    || (offsetHour === 14 && offsetMinute !== 0) || !Number.isFinite(milliseconds)) {
    throw new Error('history timestamp is invalid');
  }
  return milliseconds;
}

export function normalizeExpenseHistoryQuery(params, accountName) {
  if (!params || typeof params !== 'object' || Array.isArray(params)
    || typeof accountName !== 'string' || !accountName.trim()) throw new Error('history query is invalid');
  const startTime = timestamp(params.start_time);
  const endTime = timestamp(params.end_time);
  if (startTime > endTime || (params.type !== undefined && params.type !== 'expense')
    || (params.account_name !== undefined && params.account_name !== accountName)) {
    throw new Error('history query is outside the expense account');
  }
  const count = params.count ?? 3;
  const page = params.page ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(page) || page < 1) {
    throw new Error('history pagination is invalid');
  }
  return { ...params, type: 'expense', account_name: accountName, count: Math.min(count, 10), page, response_fields: DISPLAY_FIELDS };
}

export function readExpenseHistoryPayload(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.isError === true || result.details?.status === 'error') {
    throw new Error('history tool failed');
  }
  // OpenClaw puts native MCP structuredContent in details and projects a text
  // wrapper for the model. Consume the data object, never that display wrapper.
  const structured = result.structuredContent ?? result.details?.structuredContent;
  if (structured !== undefined) {
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
      throw new Error('history structured result is invalid');
    }
    return structured;
  }
  if (!Array.isArray(result.content) || result.content.length !== 1
    || result.content[0]?.type !== 'text' || typeof result.content[0]?.text !== 'string'
    || result.content[0].text.length > 128_000) throw new Error('history result is invalid');
  return JSON.parse(result.content[0].text);
}

function displayText(value, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength) throw new Error('history display field is invalid');
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim()
    .replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/gu, '\\$&');
}

function displayTime(milliseconds) {
  const date = new Date(milliseconds + SINGAPORE_OFFSET_MS);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`
    + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

export function formatExpenseHistory(result, query, { accountName, ledgerDisplayName }) {
  const payload = readExpenseHistoryPayload(result);
  const count = query.count;
  const page = query.page;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !Number.isInteger(count) || count < 1 || count > 10 || !Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(payload.total_count) || payload.total_count < 0
    || !Number.isSafeInteger(payload.current_page) || payload.current_page !== page
    || !Number.isSafeInteger(payload.total_page) || payload.total_page < 0
    || !Array.isArray(payload.transactions)) throw new Error('history page is invalid');
  const expectedPages = Math.ceil(payload.total_count / count);
  const expectedRows = Math.min(count, Math.max(0, payload.total_count - (page - 1) * count));
  if ((payload.total_count > 0 && (payload.total_page !== expectedPages || page > expectedPages))
    || (payload.total_count === 0 && (page !== 1 || payload.total_page > 1))
    || payload.transactions.length !== expectedRows) throw new Error('history page is incomplete');
  const lines = [`${displayText(ledgerDisplayName, 100)} · 支出明细`];
  if (payload.total_count === 0) return [...lines, '该查询范围内没有符合条件的支出记录。'].join('\n');
  let previousTime = Infinity;
  for (const [index, transaction] of payload.transactions.entries()) {
    if (!transaction || transaction.type !== 'expense' || transaction.currency !== 'SGD'
      || transaction.account_name !== accountName) throw new Error('history result is outside the expense account');
    const time = timestamp(transaction.time);
    if (time > previousTime || time < timestamp(query.start_time) || time > timestamp(query.end_time)) {
      throw new Error('history result time is outside the query');
    }
    previousTime = time;
    const minor = BigInt(parseAmountToMinorUnits(transaction.amount));
    const amount = `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')} SGD`;
    const category = displayText(transaction.category_name, 200) || '未识别分类';
    // ezBookkeeping's MCP response omits the optional field for empty notes.
    // Explicit null, objects and other malformed supplied values still fail.
    const comment = displayText(Object.hasOwn(transaction, 'comment') ? transaction.comment : '', 255) || '无';
    lines.push(`${index + 1}. ${displayTime(time)}｜${amount}｜分类：${category}｜备注：${comment}`);
  }
  if (payload.total_page > page) lines.push(`还有更多符合条件的记录，这里只列本页 ${payload.transactions.length} 笔。`);
  return lines.join('\n');
}
