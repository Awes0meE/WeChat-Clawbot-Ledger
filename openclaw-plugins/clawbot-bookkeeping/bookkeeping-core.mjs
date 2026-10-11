import { createHash } from 'node:crypto';
import { currencyBesideAmount, normalizeCurrency, startsWithCurrency, hasNegativeAmountPrefix } from './currency.mjs';
import { validateImageExpense, imageExpenseTimeParts } from './image-expense.mjs';

const MAX_EZBOOKKEEPING_AMOUNT_MINOR = 9_999_999_999_999;
const MAX_COMMENT_CHARACTERS = 255;
// Consume the complete decimal, then reject unsupported precision rather than
// treating a trailing digit as a separate candidate.
const DECIMAL_AMOUNT_SOURCE = String.raw`\d+(?:\.\d+)?`;
const SPOKEN_FRACTION_DIGIT_SOURCE = String.raw`(?:\d|[零一二两三四五六七八九])`;
const SPOKEN_AMOUNT_SOURCE = String.raw`(?:\d+|[一二两三四五六七八九十]+)块(?:(?:${SPOKEN_FRACTION_DIGIT_SOURCE}毛(?:${SPOKEN_FRACTION_DIGIT_SOURCE}(?:分)?)?)|(?:\d{1,2}|[零一二两三四五六七八九]{1,2}))?`;
const AMOUNT_PART_SOURCE = `(?:${SPOKEN_AMOUNT_SOURCE}|${DECIMAL_AMOUNT_SOURCE})`;
const AMOUNT_OPERATOR_SOURCE = String.raw`(?:[+＋*＊×xX÷/／−－-]|加|减去?|減去?|乘以?|除以?)`;
const AMOUNT_EXPRESSION = new RegExp(`${AMOUNT_PART_SOURCE}(?:\\s*${AMOUNT_OPERATOR_SOURCE}\\s*${AMOUNT_PART_SOURCE})*`, 'gu');
const AMOUNT_OPERATOR = new RegExp(`\\s*(${AMOUNT_OPERATOR_SOURCE})\\s*`, 'u');
const INSTRUCTION_INJECTION = /(?:record_expense|summarize_expenses|query_transactions|绕过.{0,8}(?:安全|限制|规则)|(?:忽略|无视|跳过).{0,12}(?:之前|前面|以上|规则|指令)|(?:调用|执行|使用).{0,8}(?:工具|函数))/iu;
const QUANTITY_OR_TIME_UNIT = /^(?:个|位|人|根|件|张|瓶|杯|盒|包|份|次|天|小时|分钟|秒|公里|千米|米|厘米|毫米|km|kg|公斤|斤|克|年|月|日|号|点)/iu;
const ADMIN_AMOUNT_CUE = /(?:订单(?:号)?|余额|原价|标价|用券|券|优惠(?:后)?|折扣|编号|单号)\s*$/u;
const ADMIN_AMOUNT_CLAUSE = /^\s*(?:订单(?:号)?|余额|原价|标价|用券|优惠|折扣|编号|单号)/u;
const EXPLICIT_QUESTION = /(?:吗|么|是不是|是否|难道|该不该|要不要)[？?]?\s*$|[？?]\s*$/u;
const SINGAPORE_UTC_OFFSET_SECONDS = 8 * 60 * 60;
const FUTURE_CLOCK_TOLERANCE_SECONDS = 5 * 60;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const LOCAL_TIME = /^(\d{2}):(\d{2})$/u;
const EXPLICIT_TIME_CUE = /(?:今天|今日|昨天|昨日|前天|大前天|明天|后天|今晚|昨晚|今早|昨早|凌晨|早上|上午|中午|下午|晚上|周[一二三四五六日天]|星期[一二三四五六日天]|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|(?:[01]?\d|2[0-3]):[0-5]\d|[零〇一二两三四五六七八九十百\d]{1,3}\s*(?:点|點|时|時)(?:\s*[零〇一二两三四五六七八九十百\d]{1,3}\s*分)?)/u;
const EXPENSE_TIME_EXPRESSIONS = new RegExp(EXPLICIT_TIME_CUE.source, 'gu');
const RECEIVED_TIME_CUE = /^(?:今天|今日|凌晨|早上|上午|中午|下午|晚上)$/u;
// A canteen number identifies the venue. Preserve decimal amounts and arithmetic
// after the name, and never discard arbitrary digits merely because a model put
// them in a comment.
const NUMBERED_CANTEEN = /(?<![A-Za-z0-9])canteen[ \t]*(?:#[ \t]*)?\d+(?![\d.A-Za-z]|[ \t]*(?:[+＋*＊×÷/／−－乘除加减減块元毛分$＄¥￥-]|新币|新元|人民币|美元|SGD\b|USD\b|CNY\b|RMB\b))/giu;
// F1 is a racing/product name, not one dollar. Do not strip arbitrary merchant
// suffixes: NTUC8.25 and Canteen7.2 still contain payment evidence.
const FORMULA_ONE = /(?<![A-Za-z0-9])F1(?![\d.]|[ \t]*(?:[+＋*＊×xX÷/／−－乘除加减減块元毛分$＄¥￥-]|新币|新元|SGD\b|USD\b|CNY\b|RMB\b))/giu;

// Voice input uses 点 for both a decimal separator and a clock. Classify the
// complete token once for both validators: never accept only its trailing digit.
const SPOKEN_POINT = /(?<![\d.零〇一二两三四五六七八九十百千万点點])(?<whole>\d+|[零〇一二两三四五六七八九十]+)[点點](?<fraction>[\d零〇一二两三四五六七八九]+)(?![\d.零〇一二两三四五六七八九十百千万点點])/gu;
const POINT_DIGITS = '零一二三四五六七八九';
function expenseNumberText(text, maskClocks = false) {
  return text.replace(SPOKEN_POINT, (token, whole, fraction, offset) => {
    const prefix = text.slice(0, offset);
    const suffix = text.slice(offset + token.length);
    const moneyCue = /(?:花了?|花费|付了?|实付|支付|支出|金额|价格|共|合计)\s*$/u.test(prefix)
      || startsWithCurrency(suffix.trimStart()) || /^[块元]/u.test(suffix);
    const clockUnit = /^\s*(?:分|秒|钟|鐘|整)/u.test(suffix);
    const clockCue = /^\s*(?:左右|的时候|時候)/u.test(suffix)
      || /(?:凌晨|早上|上午|中午|下午|晚上|今晚|昨晚|今早|昨早|在|于|於|从|從|到)\s*$/u.test(prefix)
      || /^\s*(?:吃|去|到|开始|出发|上班|下班|用餐|午饭|晚饭|早餐)/u.test(suffix);
    if (clockUnit || (clockCue && !moneyCue)) return maskClocks ? '#'.repeat(token.length) : token;
    const integer = /^\d+$/u.test(whole) ? Number(whole)
      : /^[零〇]$/u.test(whole) ? 0 : chineseWholeNumberToInteger(whole);
    if (!Number.isSafeInteger(integer)) return token;
    const digits = [...fraction].map(c => c === '〇' ? '0' : c === '两' ? '2'
      : POINT_DIGITS.includes(c) ? String(POINT_DIGITS.indexOf(c)) : c).join('');
    return `${integer}.${digits}`;
  });
}

export class ExpenseRecordingError extends Error {
  constructor(outcome, { dedupeStatus, rejectionReason, imageIssue } = {}) {
    const message = outcome === 'not_written'
      ? 'expense was not written'
      : outcome === 'rejected'
        ? 'expense write authorization was rejected'
        : 'expense write outcome is unknown';
    super(message);
    this.name = 'ExpenseRecordingError';
    this.outcome = outcome;
    if (dedupeStatus) this.dedupeStatus = dedupeStatus;
    if (['time', 'amount', 'currency', 'image', 'image_lookup'].includes(rejectionReason)) this.rejectionReason = rejectionReason;
    if (rejectionReason === 'image' && ['image-source', 'image-payment', 'image-evidence', 'image-total', 'image-currency', 'image-order', 'image-date', 'image-purpose'].includes(imageIssue)) this.imageIssue = imageIssue;
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
    if (expression.length > 512) return undefined;
    const parts = expression.split(AMOUNT_OPERATOR);
    if (parts.length > 127) return undefined;
    // Exact rational arithmetic: multiplication/division before addition/subtraction, with
    // equal-precedence operators evaluated left to right. Never round money.
    const operand = (part) => /^(?:0|0\.0{1,2})$/u.test(part.trim())
      ? 0n : BigInt(amountPartToMinorUnits(part.trim()));
    let numerator = operand(parts[0]);
    let denominator = 100n;
    let sumNumerator = 0n;
    let sumDenominator = 1n;
    let sign = 1n;
    for (let i = 1; i < parts.length; i += 2) {
      const operator = parts[i];
      const value = operand(parts[i + 1]);
      if (/^(?:[+＋加−－-]|减去?|減去?)$/u.test(operator)) {
        sumNumerator = sumNumerator * denominator + sign * numerator * sumDenominator;
        sumDenominator *= denominator;
        sign = /^[+＋加]$/u.test(operator) ? 1n : -1n;
        numerator = value;
        denominator = 100n;
      } else if (/^(?:[÷/／]|除以?)$/u.test(operator)) {
        if (value === 0n) return undefined;
        numerator *= 100n;
        denominator *= value;
      } else {
        numerator *= value;
        denominator *= 100n;
      }
    }
    numerator = (sumNumerator * denominator + sign * numerator * sumDenominator) * 100n;
    denominator *= sumDenominator;
    if (numerator % denominator !== 0n) return undefined;
    const minor = numerator / denominator;
    return minor > 0n && minor <= BigInt(MAX_EZBOOKKEEPING_AMOUNT_MINOR) ? Number(minor) : undefined;
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
  const match = part.match(/^(\d+|[一二两三四五六七八九十]+)块(?:(\d|[零一二两三四五六七八九])毛(?:(\d|[零一二两三四五六七八九])(?:分)?)?|(\d{1,2}|[零一二两三四五六七八九]{1,2}))?$/u);
  if (!match) throw new Error('unsupported spoken amount');

  const whole = /^\d+$/u.test(match[1])
    ? Number.parseInt(match[1], 10)
    : chineseWholeNumberToInteger(match[1]);
  if (!Number.isInteger(whole)) throw new Error('unsupported spoken whole amount');

  const chineseFractionDigits = new Map([
    ['零', '0'], ['一', '1'], ['二', '2'], ['两', '2'], ['三', '3'],
    ['四', '4'], ['五', '5'], ['六', '6'], ['七', '7'], ['八', '8'], ['九', '9'],
  ]);
  const fractionSource = match[2]
    ? `${match[2]}${match[3] ?? '0'}`
    : match[4] ?? '';
  const fraction = Array.from(
    fractionSource,
    (character) => chineseFractionDigits.get(character) ?? character,
  ).join('');
  return parseAmountToMinorUnits(fraction ? `${whole}.${fraction}` : String(whole));
}

function eligibleAmountCandidates(clause, clauseIndex) {
  clause = expenseNumberText(clause, true);
  if (ADMIN_AMOUNT_CLAUSE.test(clause)) return [];
  // Keep original offsets and prevent amount expressions from crossing a time span.
  const amountText = clause
    .replace(EXPENSE_TIME_EXPRESSIONS, (match) => '#'.repeat(match.length))
    .replace(NUMBERED_CANTEEN, (match) => '#'.repeat(match.length))
    .replace(FORMULA_ONE, (match) => '#'.repeat(match.length));
  const candidates = [];
  for (const match of amountText.matchAll(AMOUNT_EXPRESSION)) {
    const matchIndex = match.index ?? 0;
    // Unary negatives are not expenses. Binary subtraction is consumed as part
    // of one complete expression; dates are masked before scanning.
    if (hasNegativeAmountPrefix(amountText.slice(0, matchIndex))) return [];
    const prefix = clause.slice(0, matchIndex);
    const suffix = clause.slice(matchIndex + match[0].length).trimStart();
    // Unsupported or broken arithmetic must not become a valid operand-sized
    // proposal. A slash beside words may still be an ordinary note separator.
    if (/[+＋*＊×÷()（）^%％=]\s*$/u.test(prefix)
      || /^[+＋*＊×÷()（）^%％=]/u.test(suffix)
      || /[\d.+＋*＊×÷/／−－-]\s*(?:加|减去?|減去?|乘以?|除以?)\s*$/u.test(prefix)
      || /^(?:加|减去?|減去?|乘以?|除以?)\s*(?:[\d.+＋*＊×÷/／−－-]|$)/u.test(suffix)
      || /^[−－-]\s*(?:[\d.+＋*＊×÷/／−－-]|$)/u.test(suffix)
      || /(?:[\d./／]|[xX])\s*[/／]\s*$/u.test(prefix)
      || /^[/／]\s*(?:[\d./／+＋*＊×÷-]|$)/u.test(suffix)
      || /[\d.*＊×xX]\s*[xX]\s*$/u.test(prefix)
      || /^[xX]\s*(?:[\d.*＊×xX+＋/／÷-]|$)/u.test(suffix)) return [];
    const amountMinor = expressionAmountToMinorUnits(match[0]);
    if (amountMinor === undefined
      || /[\d.]$/u.test(prefix)
      || /^[\d.]/u.test(clause.slice(matchIndex + match[0].length))
      || (QUANTITY_OR_TIME_UNIT.test(suffix) && !startsWithCurrency(suffix))
      || ADMIN_AMOUNT_CUE.test(prefix)) continue;
    candidates.push({
      amountMinor,
      currency: (() => { try { return currencyBesideAmount(prefix, suffix); } catch { return undefined; } })(),
      clause,
      clauseIndex,
      matchIndex,
      expressionLength: match[0].length,
      needsConfirmation: /[/／]/u.test(match[0]),
    });
  }
  return candidates;
}

function expenseAmountCandidates(content) {
  const originalText = String(content ?? '');
  const commentIndex = originalText.indexOf('备注');
  const text = (commentIndex < 0 ? originalText : originalText.slice(0, commentIndex)).trim();
  if (!text || INSTRUCTION_INJECTION.test(text)) return [];

  const clauses = text.split(/[，,。；;！!\r\n]+/u).filter(Boolean);
  return clauses.flatMap((clause, clauseIndex) => eligibleAmountCandidates(clause, clauseIndex));
}

export function messageSupportsExpenseAmount(content, requestedAmountMinor, currency = 'SGD') {
  const candidates = expenseAmountCandidates(content);
  if (candidates.length !== 1) return false;
  return candidates[0].amountMinor === requestedAmountMinor && candidates[0].currency === currency;
}

export function requiresExpenseConfirmation(content) {
  const originalText = String(content ?? '');
  const commentIndex = originalText.indexOf('备注');
  const text = (commentIndex < 0 ? originalText : originalText.slice(0, commentIndex)).trim();
  return EXPLICIT_QUESTION.test(text)
    || expenseAmountCandidates(text).some((candidate) => candidate.needsConfirmation);
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

  const explicitComment = text.slice(delimiterIndex + '备注'.length)
    .replace(/^\s*[:：]\s*/u, '');
  return validateComment(explicitComment);
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
  currency = 'SGD',
  primaryCategory,
  subcategory,
  comment,
  time,
  showSeconds = false,
}) {
  const singaporeTime = new Date((Number(time) + 8 * 60 * 60) * 1000);
  const twoDigits = (value) => String(value).padStart(2, '0');
  const formattedTime = [
    singaporeTime.getUTCFullYear(),
    twoDigits(singaporeTime.getUTCMonth() + 1),
    twoDigits(singaporeTime.getUTCDate()),
  ].join('/') + ` ${twoDigits(singaporeTime.getUTCHours())}:${twoDigits(singaporeTime.getUTCMinutes())}`
    + (showSeconds ? `:${twoDigits(singaporeTime.getUTCSeconds())}` : '');
  const resolvedComment = validateComment(comment);
  const displayComment = resolvedComment.replace(/[\r\n\u2028\u2029]/gu, ' ');

  return [
    '记下来啦！🧾',
    `- 账本：[ ${ledgerDisplayName} ]`,
    `- 支出：${(Number(amountMinor) / 100).toFixed(2)} ${normalizeCurrency(currency)}`,
    `- 分类：${primaryCategory} - ${subcategory}`,
    `- 备注：${displayComment || '无'}`,
    `- 时间：${formattedTime}`,
  ].join('\n');
}

export function formatExpenseConfirmation({
  ledgerDisplayName,
  amountMinor,
  currency = 'SGD',
  primaryCategory,
  subcategory,
  comment,
  time,
  showSeconds = false,
}) {
  const receiptLines = formatExpenseReceipt({
    ledgerDisplayName,
    amountMinor,
    currency,
    primaryCategory,
    subcategory,
    comment,
    time,
    showSeconds,
  }).split('\n').slice(1);
  return [
    '帮你核对一下这笔～🤔',
    ...receiptLines,
    '- 确认：没问题就回复“是”，不记的话回复“不是”就好～',
  ].join('\n');
}

export function normalizeMessageTimestamp(timestamp) {
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('trusted message timestamp is unavailable');
  }
  return Math.trunc(numeric >= 1_000_000_000_000 ? numeric / 1000 : numeric);
}

function contentBeforeExplicitComment(content) {
  const text = String(content ?? '');
  const commentIndex = text.indexOf('备注');
  return (commentIndex < 0 ? text : text.slice(0, commentIndex)).trim();
}

function singaporeParts(timestamp) {
  const shifted = new Date(
    (normalizeMessageTimestamp(timestamp) + SINGAPORE_UTC_OFFSET_SECONDS) * 1000,
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function singaporeTimestamp({ year, month, day, hour, minute }) {
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute)
    - SINGAPORE_UTC_OFFSET_SECONDS * 1000;
  const candidate = Math.trunc(milliseconds / 1000);
  const roundTrip = singaporeParts(candidate);
  if (roundTrip.year !== year || roundTrip.month !== month || roundTrip.day !== day
    || roundTrip.hour !== hour || roundTrip.minute !== minute) {
    throw new Error('expense occurrence date or time is invalid');
  }
  return candidate;
}

export function hasExplicitExpenseTimeCue(content) {
  return EXPLICIT_TIME_CUE.test(expenseNumberText(contentBeforeExplicitComment(content)));
}

export function resolveExpenseTimestamp({ input, inbound }) {
  if (normalizeCurrency(input.currency) !== input.currency) throw new Error('expense currency must be canonical');
  const receivedTime = normalizeMessageTimestamp(inbound.timestamp);
  if (input.timeMode === 'received') {
    // Today resolves to the trusted message date, including delayed confirmations.
    // Bare day parts add no exact clock; other dates and clocks still need evidence.
    const timeCues = expenseNumberText(contentBeforeExplicitComment(inbound.content)).matchAll(EXPENSE_TIME_EXPRESSIONS);
    if (Array.from(timeCues).some((match) => !RECEIVED_TIME_CUE.test(match[0]))) {
      throw new Error('expense occurrence time requires semantic resolution');
    }
    return receivedTime;
  }
  if (input.timeMode !== 'explicit') throw new Error('expense time mode is required');

  const body = contentBeforeExplicitComment(inbound.content);
  const evidence = String(input.timeEvidence ?? '').trim();
  const imageTime = inbound.image ? imageExpenseTimeParts(input) : undefined;
  if (!imageTime && (!evidence || !body.includes(evidence) || !hasExplicitExpenseTimeCue(evidence))) {
    throw new Error('expense time evidence is not grounded');
  }

  const dateMatch = String(input.localDate ?? '').match(LOCAL_DATE);
  if (!dateMatch) throw new Error('expense local date is invalid');
  const received = singaporeParts(receivedTime);
  let hour = received.hour;
  let minute = received.minute;
  if (input.localTime !== undefined) {
    const timeMatch = String(input.localTime).match(LOCAL_TIME);
    if (!timeMatch) throw new Error('expense local time is invalid');
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2]);
  }
  const occurrenceTime = singaporeTimestamp({
    year: Number(dateMatch[1]),
    month: Number(dateMatch[2]),
    day: Number(dateMatch[3]),
    hour,
    minute,
  }) + (imageTime?.second ?? 0);
  if (occurrenceTime > receivedTime + FUTURE_CLOCK_TOLERANCE_SECONDS) {
    throw new Error('expense occurrence time is in the future');
  }
  return occurrenceTime;
}

export function formatTrustedExpenseTimeContext(timestamp) {
  const { year, month, day, hour, minute } = singaporeParts(timestamp);
  const twoDigits = (value) => String(value).padStart(2, '0');
  return [
    '[可信记账时间上下文]',
    `当前微信消息发送时间（Asia/Singapore）：${year}-${twoDigits(month)}-${twoDigits(day)} ${twoDigits(hour)}:${twoDigits(minute)}`,
    '只用它解析当前消息中的相对消费时间；不得把它当作用户声明的消费时间证据。',
  ].join('\n');
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
  if (result?.imageDuplicate) return result.previousStatus === 'created'
    ? '这张图片对应的消费已经记过啦，我没有重复入账。'
    : '这张图片已有处理记录，结果需要先核对账本；我没有重复入账。';
  if (result?.previousStatus === 'failed') {
    return '上次没有记成功，我也没有重复入账～ 请重新发一条消息再试吧。';
  }
  if (result?.previousStatus !== 'created') {
    return '这条消息还在处理，或者结果暂时不确定；我没有重复入账哦。';
  }
  return '这条消息已经处理过啦，我没有重复入账～';
}

function validateExpenseInput(input, inbound, resolvedTime) {
  if (input.imageEvidence || inbound.image) {
    try { validateImageExpense(input, inbound); }
    catch (error) { throw new ExpenseRecordingError('rejected', { rejectionReason: 'image', imageIssue: error?.message }); }
  }
  const receiptKey = messageReceiptKey(inbound);
  const sourceAmount = parseAmountToMinorUnits(input.amount);
  const comment = resolveExpenseComment(inbound.content, input.comment);
  try {
    if (normalizeCurrency(input.currency) !== input.currency) throw new Error('noncanonical currency');
    const candidates = inbound.image ? [] : expenseAmountCandidates(inbound.content);
    if (candidates.some((candidate) => candidate.amountMinor === sourceAmount)
      && !candidates.some((candidate) => candidate.amountMinor === sourceAmount && candidate.currency === input.currency)) {
      throw new Error('currency disagrees with source message');
    }
  } catch { throw new ExpenseRecordingError('rejected', { rejectionReason: 'currency' }); }
  let time;
  try {
    time = resolveExpenseTimestamp({ input, inbound: inbound.image
      ? { ...inbound, content: input.timeMode === 'explicit' ? input.timeEvidence : '' } : inbound });
    if (resolvedTime !== undefined
      && (!Number.isSafeInteger(resolvedTime) || resolvedTime !== time)) {
      throw new Error('stored expense occurrence time does not match its source');
    }
  } catch {
    throw new ExpenseRecordingError('rejected', { rejectionReason: 'time' });
  }
  return { receiptKey, sourceAmount, comment, time };
}

export function prepareExpenseConfirmation({ input, inbound }) {
  const candidate = validateExpenseInput(input, inbound);
  // A proposal may select one grounded candidate; only user confirmation can
  // authorize its write. Direct recording still requires a unique amount.
  if (!inbound.image && !expenseAmountCandidates(inbound.content).some(({ amountMinor, currency }) => amountMinor === candidate.sourceAmount && currency === input.currency)) {
    throw new ExpenseRecordingError('rejected', { rejectionReason: 'amount' });
  }
  return {
    amountMinor: candidate.sourceAmount,
    comment: candidate.comment,
    time: candidate.time,
  };
}

export async function refreshImageReceipt({ api, store, inbound, evidenceKey, validateBeforeWrite }) {
  // Replaying an old transport message never authorizes a replacement write,
  // even after its transaction was deleted or its image link has moved on.
  const original = store.receipt(messageReceiptKey(inbound));
  if (original) return original;
  const link = store.imageReceiptLink(evidenceKey);
  if (!link) return undefined;
  if (link.receipt.status !== 'created' || !link.receipt.transactionId) return link.receipt;
  try {
    const exists = await api.transactionExists(link.receipt.transactionId);
    if (exists === true) return link.receipt;
    if (exists !== false) throw new Error('unverified transaction absence');
    if (validateBeforeWrite && validateBeforeWrite() !== true) throw new Error('image authority expired');
    if (!store.releaseDeletedImageLinks(link)) throw new Error('image receipt changed during lookup');
    // Another instance may have already claimed this image for a new message.
    return store.imageReceiptLink(evidenceKey)?.receipt;
  } catch {
    throw new ExpenseRecordingError('not_written', { rejectionReason: 'image_lookup' });
  }
}

async function writeExpense({
  api,
  store,
  input,
  inbound,
  accountName = '日常支出',
  validateBeforeWrite,
  resolvedTime,
  imageConfirmed = false,
}) {
  const { receiptKey, sourceAmount, comment, time } = validateExpenseInput(
    input,
    inbound,
    resolvedTime,
  );
  const clientSessionId = clientSessionIdFor(receiptKey);
  const image = inbound.image ? imageExpenseKeys(input, inbound, imageConfirmed) : undefined;
  if (image) {
    for (const evidenceKey of [image.attachmentKey, ...(!imageConfirmed && image.orderKey ? [image.orderKey] : [])]) {
      await refreshImageReceipt({ api, store, inbound, evidenceKey, validateBeforeWrite });
    }
  }
  const existing = store.claim(receiptKey, image);
  if (existing) {
    return {
      status: 'duplicate',
      previousStatus: existing.status,
      transactionId: existing.transactionId,
      ...(existing.imageDuplicate ? { imageDuplicate: true } : {}),
    };
  }

  let sourceAccountId;
  let categoryId;
  try {
    sourceAccountId = await api.resolveAccountId(accountName, input.currency);
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
    ...(input.currency === 'SGD' ? {} : { currency: input.currency }),
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
  if (options.inbound.image || options.input.imageEvidence) {
    try {
      if (validateImageExpense(options.input, options.inbound).needsConfirmation) throw new Error();
    } catch (error) { throw new ExpenseRecordingError('rejected', { rejectionReason: 'image', imageIssue: error?.message }); }
  } else if (!messageSupportsExpenseAmount(options.inbound.content, sourceAmount, options.input.currency)) {
    throw new ExpenseRecordingError('rejected', { rejectionReason: 'amount' });
  }
  if (requiresExpenseConfirmation(options.inbound.content)) {
    throw new ExpenseRecordingError('rejected');
  }
  return writeExpense(options);
}

export async function recordConfirmedExpense(options) {
  return writeExpense({ ...options, imageConfirmed: true });
}

export function imageExpenseKeys(input, inbound, confirmed = false) {
  const { orderHash } = validateImageExpense(input, inbound, { confirmed });
  const key = (kind, value) => createHash('sha256').update(`${inbound.recipientKey}\u0000${kind}\u0000${value}`).digest('hex');
  return { attachmentKey: imageAttachmentKey(inbound), ...(orderHash ? { orderKey: key('order', orderHash) } : {}), confirmed };
}

export function imageAttachmentKey(inbound) {
  if (!/^[a-f0-9]{64}$/u.test(inbound.recipientKey ?? '') || !/^[a-f0-9]{64}$/u.test(inbound.image?.sha256 ?? '')) throw new Error('invalid image identity');
  return createHash('sha256').update(`${inbound.recipientKey}\u0000image\u0000${inbound.image.sha256}`).digest('hex');
}
