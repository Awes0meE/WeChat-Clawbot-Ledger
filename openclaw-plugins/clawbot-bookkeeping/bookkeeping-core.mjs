import { createHash } from 'node:crypto';

const MAX_EZBOOKKEEPING_AMOUNT_MINOR = 9_999_999_999_999;
const MAX_COMMENT_CHARACTERS = 255;

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

export function extractVerbatimComment(content) {
  const text = String(content ?? '');
  const delimiterIndex = text.indexOf('备注');
  if (delimiterIndex < 0) return '';

  const comment = text.slice(delimiterIndex + '备注'.length);
  if (Array.from(comment).length > MAX_COMMENT_CHARACTERS) {
    throw new Error('comment exceeds ezBookkeeping 255-character limit');
  }
  return comment;
}

export function normalizeMessageTimestamp(timestamp) {
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('trusted message timestamp is unavailable');
  }
  return Math.trunc(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric);
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
  const existing = store.claim(receiptKey);
  if (existing) {
    return {
      status: 'duplicate',
      previousStatus: existing.status,
      transactionId: existing.transactionId,
    };
  }

  const clientSessionId = clientSessionIdFor(receiptKey);
  try {
    const sourceAmount = parseAmountToMinorUnits(input.amount);
    const comment = extractVerbatimComment(inbound.content);
    const time = normalizeMessageTimestamp(inbound.timestamp);
    const sourceAccountId = await api.resolveAccountId(accountName);
    const categoryId = await api.resolveExpenseCategoryId(input.primaryCategory, input.subcategory);
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
    const created = await api.addTransaction(body);
    const receipt = {
      status: 'created',
      transactionId: created.id,
      clientSessionId,
      amount: input.amount,
      primaryCategory: input.primaryCategory,
      subcategory: input.subcategory,
      time,
      comment,
    };
    store.complete(receiptKey, receipt);
    return receipt;
  } catch (error) {
    store.fail(receiptKey, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      clientSessionId,
    });
    throw error;
  }
}
