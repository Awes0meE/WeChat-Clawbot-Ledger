import { createHash } from 'node:crypto';

const MAX_EZBOOKKEEPING_AMOUNT_MINOR = 9_999_999_999_999;
const MAX_COMMENT_CHARACTERS = 255;
const AMOUNT_EXPRESSION = /\d+(?:\.\d{1,2})?(?:\s*[+＋]\s*\d+(?:\.\d{1,2})?)*/gu;
const QUERY_CONTEXT = /(?:多少|几笔|什么|哪些|哪笔|查(?:询|一下|下|看|账)?|统计|汇总|合计|总计|历史|最近|买过|有没有|是否|吗|嘛|呢|[?？])/u;
const NON_EXPENSE_CONTEXT = /(?:不要记|不用记|别记|不记账|不要入账|别入账|取消记账|取消入账|撤销|比如|例如|举例|假如|假设|如果|要是|倘若|预计|估计|预算|计划|打算|可能|还没付(?:款)?|尚未付(?:款)?|未付(?:款)?|没付(?:款)?|待付(?:款)?|朋友.{0,4}(?:转|给|付|还)(?:给)?我|别人.{0,4}(?:转|给|付|还)(?:给)?我|收到|收款|收入|工资|奖金)/u;
const INSTRUCTION_INJECTION = /(?:record_expense|summarize_expenses|query_transactions|(?:忽略|无视|跳过).{0,12}(?:之前|前面|以上|规则|指令)|(?:调用|执行|使用).{0,8}(?:工具|函数))/iu;
const QUANTITY_OR_TIME_UNIT = /^(?:个|位|人|根|件|张|瓶|杯|盒|包|份|次|天|小时|分钟|秒|公里|千米|米|厘米|毫米|km|kg|公斤|斤|克|年|月|日|号|点)/iu;

export class ExpenseRecordingError extends Error {
  constructor(outcome) {
    const message = outcome === 'not_written'
      ? 'expense was not written'
      : outcome === 'rejected'
        ? 'expense write authorization was rejected'
        : 'expense write outcome is unknown';
    super(message);
    this.name = 'ExpenseRecordingError';
    this.outcome = outcome;
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

function hasExpenseContextText(clause) {
  const residue = clause
    .replace(AMOUNT_EXPRESSION, '')
    .replace(/(?:SGD|新币|新元|人民币|块钱|块|元)/giu, '')
    .replace(/[年月日号点分秒￥¥$\s+\-*/=：:（）()【】\[\]]/gu, '');
  return /\p{L}/u.test(residue);
}

function isAuthorizedExpenseMessage(content, requestedAmountMinor) {
  const text = String(content ?? '').trim();
  if (!text || INSTRUCTION_INJECTION.test(text)) return false;

  let blockedByEarlierClause = false;
  for (const clause of text.split(/[，,。；;！!\r\n]+/u)) {
    if (!clause) continue;
    const disallowedContext = QUERY_CONTEXT.test(clause) || NON_EXPENSE_CONTEXT.test(clause);
    const matchingAmount = [...clause.matchAll(AMOUNT_EXPRESSION)].some((match) => {
      const suffix = clause.slice((match.index ?? 0) + match[0].length).trimStart();
      return !QUANTITY_OR_TIME_UNIT.test(suffix)
        && expressionAmountToMinorUnits(match[0]) === requestedAmountMinor;
    });
    if (matchingAmount) {
      return !blockedByEarlierClause && !disallowedContext && hasExpenseContextText(clause);
    }
    if (disallowedContext) blockedByEarlierClause = true;
  }
  return false;
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

export async function recordExpense({ api, store, input, inbound, accountName = '日常支出' }) {
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
    store.fail(receiptKey, {
      status: 'failed',
      clientSessionId,
    });
    throw new ExpenseRecordingError('not_written');
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
    store.uncertain(receiptKey, {
      status: 'unknown',
      clientSessionId,
    });
    throw new ExpenseRecordingError('unknown');
  }
  const transactionId = typeof created?.id === 'string' ? created.id.trim() : '';
  if (!transactionId) {
    store.uncertain(receiptKey, {
      status: 'unknown',
      clientSessionId,
    });
    throw new ExpenseRecordingError('unknown');
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
