import { createHash } from 'node:crypto';

const MAX_EZBOOKKEEPING_AMOUNT_MINOR = 9_999_999_999_999;
const MAX_COMMENT_CHARACTERS = 255;
const AMOUNT_EXPRESSION = /\d+(?:\.\d{1,2})?(?:\s*[+＋]\s*\d+(?:\.\d{1,2})?)*/gu;
const INSTRUCTION_INJECTION = /(?:record_expense|summarize_expenses|query_transactions|绕过.{0,8}(?:安全|限制|规则)|(?:忽略|无视|跳过).{0,12}(?:之前|前面|以上|规则|指令)|(?:调用|执行|使用).{0,8}(?:工具|函数))/iu;
const QUANTITY_OR_TIME_UNIT = /^(?:个|位|人|根|件|张|瓶|杯|盒|包|份|次|天|小时|分钟|秒|公里|千米|米|厘米|毫米|km|kg|公斤|斤|克|年|月|日|号|点)/iu;
const ADMIN_AMOUNT_CUE = /(?:订单(?:号)?|余额|原价|标价|用券|券|优惠(?:后)?|折扣|编号|单号)\s*$/u;
const ADMIN_AMOUNT_CLAUSE = /^\s*(?:订单(?:号)?|余额|原价|标价|用券|优惠|折扣|编号|单号)/u;
const EXPLICIT_COMMAND_PREFIX = /^(?:(?:(?:请|麻烦)?(?:帮我|给我)?(?:记账|记一笔|记|记录一下|记录|入账))|(?:能帮我(?:记账|记一笔|记|记录一下|记录|入账)))\s*[：:]?\s*/u;
const NEGATED_COMMAND_DESCRIPTION = /^(?:不要|别|无需|不用|取消|停止|撤销)/u;
const SAFE_SHORTHAND = /^(?:早饭|早餐|午饭|午餐|晚饭|晚餐|夜宵|咖啡|奶茶|餐饮|买菜|NTUC购物|食阁吃饭|检查费)$/iu;
const SAFE_DESCRIPTION = /^[\p{L}\p{N}][\p{L}\p{N}\s·&（）()\-]{0,59}$/u;
const CURRENCY_OR_MODAL_SUFFIX = /^\s*(?:(?:SGD|新币|新元|人民币|块钱|块|元)\s*)?(?:吗|嘛|呢)?[?？]?\s*$/iu;
const SELF_AT_TRAILING_ACTION = /^我(?:刚刚?|刚才|今天|昨晚|中午|晚上)?在(.+?)(?:花了?|消费了?|支付了?|付了?|付款)$/u;
const SELF_SHORTHAND_TRAILING_ACTION = /^我(?:刚刚?|刚才|今天|昨晚|中午|晚上)?(.+?)(?:花了?|消费了?|支付了?|付了?|付款)$/u;
const SELF_AMOUNT_ONLY_ACTION = /^我(?:刚刚?|刚才|今天|昨晚|中午|晚上)?(?:花了?|消费了?|支付了?|付了?|付款|买了?)$/u;
const SELF_LEADING_ACTION = /^我(?:刚刚?|刚才|今天|昨晚|中午|晚上)?(?:买了?|购入|吃了?)(.+)$/u;
const SHORTHAND_TRAILING_ACTION = /^(.*?)(?:花了?|消费了?)$/u;
const ORDER_REFERENCE_CLAUSE = /^订单(?:号)?\s*\d+$/u;
const ADMIN_SUFFIX_CLAUSE = /^(?:余额|用券)\s*\d+(?:\.\d{1,2})?(?:\s*[+＋]\s*\d+(?:\.\d{1,2})?)*$/u;
const READ_AFTER_WRITE_CLAUSE = /^顺便(?:查|查询)(?:本月|这个月|本周|今天|上月|上个月|今年)?(?:支出|消费|账单|记录)$/u;
const PURCHASE_DETAIL_START = /^买了(?:[一二两三四五六七八九十百千万]+(?:个|根|件|张|瓶|杯|盒|包|份))?[\p{L}]{1,30}$/u;
const PURCHASE_DETAIL_ITEM = /^(?:[一二两三四五六七八九十百千万]+(?:个|根|件|张|瓶|杯|盒|包|份))?[\p{L}]{1,30}$/u;
const ORIGINAL_PRICE_CLAUSE = /^(早饭|早餐|午饭|午餐|晚饭|晚餐|夜宵|咖啡|奶茶|餐饮|买菜|NTUC购物|食阁吃饭|检查费)原价\d+(?:\.\d{1,2})?$/iu;

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
      .split(/[+＋]/u)
      .reduce((sum, part) => sum + parseAmountToMinorUnits(part.trim()), 0);
  } catch {
    return undefined;
  }
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

function classifyProvableExpenseClause(candidate) {
  const prefix = candidate.clause.slice(0, candidate.matchIndex).trim();
  const suffix = candidate.clause.slice(candidate.matchIndex + candidate.expressionLength);
  if (!CURRENCY_OR_MODAL_SUFFIX.test(suffix)) return undefined;

  const command = prefix.match(EXPLICIT_COMMAND_PREFIX);
  if (command) {
    const description = prefix.slice(command[0].length).trim();
    return SAFE_DESCRIPTION.test(description) && !NEGATED_COMMAND_DESCRIPTION.test(description)
      ? { kind: 'command', description }
      : undefined;
  }

  const selfAtTrailing = prefix.match(SELF_AT_TRAILING_ACTION);
  if (selfAtTrailing && SAFE_DESCRIPTION.test(selfAtTrailing[1].trim())) {
    return { kind: 'self-action', description: selfAtTrailing[1].trim() };
  }
  if (SELF_AMOUNT_ONLY_ACTION.test(prefix)) {
    return { kind: 'self-action', description: '' };
  }
  const selfShorthandTrailing = prefix.match(SELF_SHORTHAND_TRAILING_ACTION);
  if (selfShorthandTrailing && SAFE_SHORTHAND.test(selfShorthandTrailing[1].trim())) {
    return { kind: 'self-action', description: selfShorthandTrailing[1].trim() };
  }
  const selfLeading = prefix.match(SELF_LEADING_ACTION);
  if (selfLeading && SAFE_DESCRIPTION.test(selfLeading[1].trim())) {
    return { kind: 'self-action', description: selfLeading[1].trim() };
  }

  if (SAFE_SHORTHAND.test(prefix)) return { kind: 'shorthand', description: prefix };
  const shorthandAction = prefix.match(SHORTHAND_TRAILING_ACTION);
  if (shorthandAction && SAFE_SHORTHAND.test(shorthandAction[1].trim())) {
    return { kind: 'shorthand-action', description: shorthandAction[1].trim() };
  }
  if (/^(?:实付|实际支付|已付)$/u.test(prefix)) {
    return { kind: 'actual-paid', description: '' };
  }
  return undefined;
}

function hasFullyMatchedAuthorization(clauses, candidate, syntax) {
  let purchaseDetailsStarted = false;
  for (let index = 0; index < clauses.length; index += 1) {
    if (index === candidate.clauseIndex) continue;
    const clause = clauses[index].trim();
    if (index < candidate.clauseIndex) {
      if (ORDER_REFERENCE_CLAUSE.test(clause)) continue;
      if (syntax.kind === 'actual-paid'
        && index === candidate.clauseIndex - 1
        && ORIGINAL_PRICE_CLAUSE.test(clause)) continue;
      return false;
    }

    if (ADMIN_SUFFIX_CLAUSE.test(clause) || READ_AFTER_WRITE_CLAUSE.test(clause)) continue;
    if (syntax.description.toUpperCase() === 'NTUC购物'.toUpperCase()) {
      if (!purchaseDetailsStarted && PURCHASE_DETAIL_START.test(clause)) {
        purchaseDetailsStarted = true;
        continue;
      }
      if (purchaseDetailsStarted && PURCHASE_DETAIL_ITEM.test(clause)) continue;
    }
    return false;
  }
  return syntax.kind !== 'actual-paid'
    || (candidate.clauseIndex > 0 && ORIGINAL_PRICE_CLAUSE.test(clauses[candidate.clauseIndex - 1].trim()));
}

function isAuthorizedExpenseMessage(content, requestedAmountMinor) {
  const originalText = String(content ?? '');
  const commentIndex = originalText.indexOf('备注');
  const text = (commentIndex < 0 ? originalText : originalText.slice(0, commentIndex)).trim();
  if (!text || INSTRUCTION_INJECTION.test(text)) return false;

  const clauses = text.split(/[，,。；;！!\r\n]+/u).filter(Boolean);
  const candidates = clauses.flatMap((clause, clauseIndex) => eligibleAmountCandidates(clause, clauseIndex));
  if (candidates.length !== 1) return false;

  const candidate = candidates[0];
  if (candidate.amountMinor !== requestedAmountMinor) return false;
  const syntax = classifyProvableExpenseClause(candidate);
  return syntax !== undefined && hasFullyMatchedAuthorization(clauses, candidate, syntax);
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

export async function recordExpense({
  api,
  store,
  input,
  inbound,
  accountName = '日常支出',
  validateBeforeWrite,
}) {
  const receiptKey = messageReceiptKey(inbound);
  const sourceAmount = parseAmountToMinorUnits(input.amount);
  if (!isAuthorizedExpenseMessage(inbound.content, sourceAmount)) {
    throw new ExpenseRecordingError('rejected');
  }
  const comment = resolveExpenseComment(inbound.content, input.comment);
  const time = normalizeMessageTimestamp(inbound.timestamp);
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
