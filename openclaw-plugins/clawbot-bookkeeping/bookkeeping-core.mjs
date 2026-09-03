import { createHash } from 'node:crypto';

const MAX_EZBOOKKEEPING_AMOUNT_MINOR = 9_999_999_999_999;
const MAX_COMMENT_CHARACTERS = 255;
const DECIMAL_AMOUNT_SOURCE = String.raw`\d+(?:\.\d{1,2})?`;
const SPOKEN_AMOUNT_SOURCE = String.raw`(?:\d+|[一二两三四五六七八九十]+)块(?:\d{1,2}|[零一二两三四五六七八九]{1,2})?`;
const AMOUNT_PART_SOURCE = `(?:${SPOKEN_AMOUNT_SOURCE}|${DECIMAL_AMOUNT_SOURCE})`;
const AMOUNT_EXPRESSION = new RegExp(`${AMOUNT_PART_SOURCE}(?:\\s*(?:[+＋]|加)\\s*${AMOUNT_PART_SOURCE})*`, 'gu');
const INSTRUCTION_INJECTION = /(?:record_expense|summarize_expenses|query_transactions|绕过.{0,8}(?:安全|限制|规则)|(?:忽略|无视|跳过).{0,12}(?:之前|前面|以上|规则|指令)|(?:调用|执行|使用).{0,8}(?:工具|函数))/iu;
const QUANTITY_OR_TIME_UNIT = /^(?:个|位|人|根|件|张|瓶|杯|盒|包|份|次|天|小时|分钟|秒|公里|千米|米|厘米|毫米|km|kg|公斤|斤|克|年|月|日|号|点)/iu;
const ADMIN_AMOUNT_CUE = /(?:订单(?:号)?|余额|原价|标价|用券|券|优惠(?:后)?|折扣|编号|单号)\s*$/u;
const ADMIN_AMOUNT_CLAUSE = /^\s*(?:订单(?:号)?|余额|原价|标价|用券|优惠|折扣|编号|单号)/u;
const EXPLICIT_QUESTION = /(?:吗|么|是不是|是否|难道|该不该|要不要)[？?]?\s*$|[？?]\s*$/u;

export class ExpenseRecordingError extends Error {
  constructor(outcome, { dedupeStatus } = {}) {
    const message = outcome === 'not_written'
      ? 'expense was not written'
      : outcome === 'rejected'
        ? 'expense write authorization was rejected'
        : 'expense write outcome is unknown';
    super(message);
    this.name = 'ExpenseRecordingError';
    this.outcome = outcome;
    if (dedupeStatus) this.dedupeStatus = dedupeStatus;
  }
}

export function parseAmountToMinorUnits(value) {
  const text = String(value ?? '');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) {
    throw new Error('amount must be a positive decimal with at most two fraction digits');
  }

  const [whole, fraction = ''] = text.split('.');
  const minorUnits = Number.parseInt(whole, 10) * 100 + Number.parseInt(fraction.padEnd(2, '0') || '0', 10);
  if (!Number.isSafeInteger(minorUnits) || minorUnits <= 0 || minorUnits > MAX_EZBOOKKEEPING_AMOUNT_MINOR) {
    throw new Error('amount is outside the supported ezBookkeeping range');
  }
  return minorUnits;
}

function expressionAmountToMinorUnits(expression) {
  try {
    return expression
      .split(/[+＋加]/u)
      .reduce((sum, part) => sum + amountPartToMinorUnits(part.trim()), 0);
  } catch {
    return undefined;
  }
}

function chineseWholeNumberToInteger(value) {
  const digitValues = new Map([
    ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4],
    ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9],
  ]);
  if (!value.includes('十')) return digitValues.get(value);
  const match = value.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u);
  if (!match) return undefined;
  return (match[1] ? digitValues.get(match[1]) : 1) * 10
    + (match[2] ? digitValues.get(match[2]) : 0);
}

function amountPartToMinorUnits(part) {
  if (!part.includes('块')) return parseAmountToMinorUnits(part);
  const match = part.match(/^(\d+|[一二两三四五六七八九十]+)块(\d{1,2}|[零一二两三四五六七八九]{1,2})?$/u);
  if (!match) throw new Error('unsupported spoken amount');

  const whole = /^\d+$/u.test(match[1])
    ? Number.parseInt(match[1], 10)
    : chineseWholeNumberToInteger(match[1]);
  if (!Number.isInteger(whole)) throw new Error('unsupported spoken whole amount');

  const chineseFractionDigits = new Map([
    ['零', '0'], ['一', '1'], ['二', '2'], ['两', '2'], ['三', '3'],
    ['四', '4'], ['五', '5'], ['六', '6'], ['七', '7'], ['八', '8'], ['九', '9'],
  ]);
  const fraction = match[2]
    ? Array.from(match[2], (character) => chineseFractionDigits.get(character) ?? character).join('')
    : '';
  return parseAmountToMinorUnits(fraction ? `${whole}.${fraction}` : String(whole));
}

function eligibleAmountCandidates(clause, clauseIndex) {
  if (ADMIN_AMOUNT_CLAUSE.test(clause)) return [];
  const candidates = [];
  for (const match of clause.matchAll(AMOUNT_EXPRESSION)) {
    const matchIndex = match.index ?? 0;
    const prefix = clause.slice(0, matchIndex);
    const suffix = clause.slice(matchIndex + match[0].length).trimStart();
    const amountMinor = expressionAmountToMinorUnits(match[0]);
    if (amountMinor === undefined
      || QUANTITY_OR_TIME_UNIT.test(suffix)
      || ADMIN_AMOUNT_CUE.test(prefix)) continue;
    candidates.push({
      amountMinor,
      clause,
      clauseIndex,
      matchIndex,
      expressionLength: match[0].length,
    });
  }
  return candidates;
}

export function messageSupportsExpenseAmount(content, requestedAmountMinor) {
  const originalText = String(content ?? '');
  const commentIndex = originalText.indexOf('备注');
  const text = (commentIndex < 0 ? originalText : originalText.slice(0, commentIndex)).trim();
  if (!text || INSTRUCTION_INJECTION.test(text)) return false;

  const clauses = text.split(/[，,。；;！!\r\n]+/u).filter(Boolean);
  const candidates = clauses.flatMap((clause, clauseIndex) => eligibleAmountCandidates(clause, clauseIndex));
  if (candidates.length !== 1) return false;
  return candidates[0].amountMinor === requestedAmountMinor;
}

export function requiresExpenseConfirmation(content) {
  const originalText = String(content ?? '');
  const commentIndex = originalText.indexOf('备注');
  const text = (commentIndex < 0 ? originalText : originalText.slice(0, commentIndex)).trim();
  return EXPLICIT_QUESTION.test(text);
}

function normalizeTransactionId(value) {
  if (typeof value !== 'string') return '';
  const transactionId = value.trim();
  if (Array.from(transactionId).length > 128 || /[\p{C}\p{Zl}\p{Zp}]/u.test(transactionId)) {
    return '';
  }
  return transactionId;
}

function persistOutcome(store, method, receiptKey, payload) {
  try {
    store[method](receiptKey, payload);
    return undefined;
  } catch {
    return 'unconfirmed';
  }
}

export function extractVerbatimComment(content) {
  const text = String(content ?? '');
  const delimiterIndex = text.indexOf('备注');
  if (delimiterIndex < 0) return '';

  return validateComment(text.slice(delimiterIndex + '备注'.length));
}

export function validateComment(value) {
  const comment = String(value ?? '').trim();
  if (Array.from(comment).length > MAX_COMMENT_CHARACTERS) {
    throw new Error('comment exceeds ezBookkeeping 255-character limit');
  }
  return comment === '无' ? '' : comment;
}

export function resolveExpenseComment(content, semanticComment = '') {
  if (String(content ?? '').includes('备注')) {
    return extractVerbatimComment(content);
  }
  return validateComment(semanticComment);
}

export function formatExpenseReceipt({
  ledgerDisplayName,
  amountMinor,
  primaryCategory,
  subcategory,
  comment,
  time,
}) {
  const singaporeTime = new Date((Number(time) + 8 * 60 * 60) * 1000);
  const twoDigits = (value) => String(value).padStart(2, '0');
  const formattedTime = [
    singaporeTime.getUTCFullYear(),
    twoDigits(singaporeTime.getUTCMonth() + 1),
    twoDigits(singaporeTime.getUTCDate()),
  ].join('/') + ` ${twoDigits(singaporeTime.getUTCHours())}:${twoDigits(singaporeTime.getUTCMinutes())}`;
  const resolvedComment = validateComment(comment);
  const displayComment = resolvedComment.replace(/[\r\n\u2028\u2029]/gu, ' ');

  return [
    '记下来啦！🧾',
    `账本：[ ${ledgerDisplayName} ]`,
    `支出：${(Number(amountMinor) / 100).toFixed(2)} SGD`,
    `分类：${primaryCategory} - ${subcategory}`,
    `备注：${displayComment || '无'}`,
    `时间：${formattedTime}`,
  ].join('\n');
}

export function formatExpenseConfirmation({
  ledgerDisplayName,
  amountMinor,
  primaryCategory,
  subcategory,
  comment,
  time,
}) {
  const receiptLines = formatExpenseReceipt({
    ledgerDisplayName,
    amountMinor,
    primaryCategory,
    subcategory,
    comment,
    time,
  }).split('\n').slice(1);
  return [
    '你是想记下这笔吗？🤔',
    ...receiptLines,
    '回复“是”确认，回复“不是”取消。',
  ].join('\n');
}

export function normalizeMessageTimestamp(timestamp) {
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('trusted message timestamp is unavailable');
  }
  return Math.trunc(numeric >= 1_000_000_000_000 ? numeric / 1000 : numeric);
}

function messageReceiptKey(inbound) {
  if (!inbound?.messageId) {
    throw new Error('trusted inbound message id is unavailable; refusing to write');
  }
  const channel = String(inbound.channel || 'unknown');
  return `${channel}:${String(inbound.messageId)}`;
}

function clientSessionIdFor(receiptKey) {
  return createHash('sha256').update(receiptKey, 'utf8').digest('hex');
}

export function duplicateResponseText(result) {
  if (result?.previousStatus === 'failed') {
    return '上一处理尝试失败，未重复入账；请重新发送一条消息重试。';
  }
  if (result?.previousStatus !== 'created') {
    return '同一条微信消息正在处理或状态未确认，未重复入账。';
  }
  return '同一条微信消息已处理，未重复入账。';
}

function validateExpenseInput(input, inbound) {
  const receiptKey = messageReceiptKey(inbound);
  const sourceAmount = parseAmountToMinorUnits(input.amount);
  const comment = resolveExpenseComment(inbound.content, input.comment);
  const time = normalizeMessageTimestamp(inbound.timestamp);
  return { receiptKey, sourceAmount, comment, time };
}

export function prepareExpenseConfirmation({ input, inbound }) {
  const candidate = validateExpenseInput(input, inbound);
  if (!messageSupportsExpenseAmount(inbound.content, candidate.sourceAmount)) {
    throw new ExpenseRecordingError('rejected');
  }
  return {
    amountMinor: candidate.sourceAmount,
    comment: candidate.comment,
    time: candidate.time,
  };
}

async function writeExpense({
  api,
  store,
  input,
  inbound,
  accountName = '日常支出',
  validateBeforeWrite,
}) {
  const { receiptKey, sourceAmount, comment, time } = validateExpenseInput(input, inbound);
  const clientSessionId = clientSessionIdFor(receiptKey);
  const existing = store.claim(receiptKey);
  if (existing) {
    return {
      status: 'duplicate',
      previousStatus: existing.status,
      transactionId: existing.transactionId,
    };
  }

  let sourceAccountId;
  let categoryId;
  try {
    sourceAccountId = await api.resolveAccountId(accountName);
    categoryId = await api.resolveExpenseCategoryId(input.primaryCategory, input.subcategory);
  } catch {
    const dedupeStatus = persistOutcome(store, 'fail', receiptKey, {
      status: 'failed',
      clientSessionId,
    });
    throw new ExpenseRecordingError('not_written', { dedupeStatus });
  }

  let writeStillAuthorized = true;
  if (typeof validateBeforeWrite === 'function') {
    try {
      writeStillAuthorized = validateBeforeWrite() === true;
    } catch {
      writeStillAuthorized = false;
    }
  }
  if (!writeStillAuthorized) {
    const dedupeStatus = persistOutcome(store, 'fail', receiptKey, {
      status: 'failed',
      clientSessionId,
    });
    throw new ExpenseRecordingError('not_written', { dedupeStatus });
  }

  const body = {
    type: 3,
    categoryId,
    time,
    utcOffset: 480,
    sourceAccountId,
    sourceAmount,
    destinationAccountId: '0',
    destinationAmount: 0,
    hideAmount: false,
    tagIds: [],
    pictureIds: [],
    comment,
    clientSessionId,
  };
  let created;
  try {
    created = await api.addTransaction(body);
  } catch {
    const dedupeStatus = persistOutcome(store, 'uncertain', receiptKey, {
      status: 'unknown',
      clientSessionId,
    });
    throw new ExpenseRecordingError('unknown', { dedupeStatus });
  }
  const transactionId = normalizeTransactionId(created?.id);
  if (!transactionId) {
    const dedupeStatus = persistOutcome(store, 'uncertain', receiptKey, {
      status: 'unknown',
      clientSessionId,
    });
    throw new ExpenseRecordingError('unknown', { dedupeStatus });
  }
  const receipt = {
    status: 'created',
    transactionId,
    clientSessionId,
    amountMinor: sourceAmount,
    primaryCategory: input.primaryCategory,
    subcategory: input.subcategory,
    time,
    comment,
  };
  try {
    store.complete(receiptKey, receipt);
  } catch {
    return { ...receipt, dedupeStatus: 'unconfirmed' };
  }
  return receipt;
}

export async function recordExpense(options) {
  const sourceAmount = parseAmountToMinorUnits(options.input.amount);
  if (!messageSupportsExpenseAmount(options.inbound.content, sourceAmount)
    || requiresExpenseConfirmation(options.inbound.content)) {
    throw new ExpenseRecordingError('rejected');
  }
  return writeExpense(options);
}

export async function recordConfirmedExpense(options) {
  return writeExpense(options);
}
