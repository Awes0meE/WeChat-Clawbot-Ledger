import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';

const HASH = /^[a-f0-9]{64}$/u;
export function normalizeImageAttachment(value) {
  if (!value || !HASH.test(value.sha256 ?? '') || typeof value.path !== 'string'
    || !isAbsolute(value.path) || !Number.isSafeInteger(value.bytes) || value.bytes <= 0
    || value.bytes > 10 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(value.type)) return;
  return { path: value.path, sha256: value.sha256, bytes: value.bytes, type: value.type };
}

// Called only with framework event metadata, never tool arguments or prompt text.
export function readInboundImage(event, stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), '.openclaw')) {
  if (!event.messageId || event.media?.length !== 1 || event.media[0].messageId !== event.messageId) return;
  const paths = event.media.map((m) => m.path);
  if (paths.length !== 1 || typeof paths[0] !== 'string' || event.replyToIsQuote || event.metadata?.replyToIsQuote) return;
  try {
    const root = realpathSync(join(stateDir, 'media', 'inbound'));
    const path = paths[0];
    const stat = lstatSync(path);
    const actual = realpathSync(path);
    const rel = relative(root, actual);
    if (!stat.isFile() || stat.isSymbolicLink() || actual !== path || !rel || rel.startsWith('..')
      || isAbsolute(rel) || stat.size <= 0 || stat.size > 10 * 1024 * 1024) return;
    const bytes = readFileSync(path);
    const type = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'image/jpeg'
      : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : undefined;
    return normalizeImageAttachment({ path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, type });
  } catch { return; }
}

export function imageRunMatches(inbound) {
  // The official Codex hook omits channelContext and its prompt omits the
  // transport envelope. Only the channel's async dispatch scope can bridge it;
  // model text/arguments cannot create or select this identity.
  const identity = globalThis[Symbol.for('clawbot.weixin.inbound-image-context.v1')]?.getStore();
  if (!identity || !normalizeImageAttachment(inbound.image)) return false;
  const recipientKey = createHash('sha256').update(`recipient\u0000${inbound.channel}\u0000${identity.senderId}`).digest('hex');
  return identity.messageId === inbound.messageId && identity.accountId === inbound.imageAccountId
    && identity.imagePath === inbound.image.path && recipientKey === inbound.recipientKey;
}

export function imageConfirmationSelection(content) {
  const match = String(content).trim().match(/^(确认|取消)第?([1-9]\d{0,8})笔[。.!！,，~～]*$/u);
  return match ? { decision: match[1] === '确认' ? 'confirm' : 'cancel', proposalId: Number(match[2]) } : undefined;
}

// The model selects one purchase-related timestamp from the current image.
// V2 checks normalized fields; the legacy quoted-text parser remains available
// for previously persisted proposals. Both preserve seconds through confirmation.
export function imageExpenseTimeParts(input) {
  if (input.imageEvidence?.semanticVersion === 2) {
    // The official model resolves locale, labels and date spelling. This layer
    // checks the typed result; it cannot independently verify pixel semantics.
    const evidence = input.imageEvidence;
    if (!['expense', 'payment', 'purchase', 'transaction', 'order'].includes(evidence.timeKind)
      || evidence.dateAmbiguous !== false || input.timeMode !== 'explicit'
      || !boundedEvidence(input.timeEvidence, 100)) throw new Error('image-date');
    if (evidence.localSecond !== undefined && (input.localTime === undefined
      || !Number.isInteger(evidence.localSecond) || evidence.localSecond < 0
      || evidence.localSecond > 59)) throw new Error('image-date');
    return { second: evidence.localSecond ?? 0, showSeconds: evidence.localSecond !== undefined };
  }
  const raw = input.timeEvidence;
  if (typeof raw !== 'string' || raw.length > 100) throw new Error('image-time');
  const evidence = raw.normalize('NFKC').trim().replace(
    /(\d{1,2})时\s*(\d{1,2})分(?:\s*(\d{1,2})秒)?/gu,
    (_, hour, minute, second) => `${hour}:${minute}${second === undefined ? '' : `:${second}`}`,
  );
  // Card transaction detail pages can show the purchase date without a label,
  // separated from the clock by a comma. Keep the whole evidence anchored so
  // logistics labels or a second timestamp cannot be silently stripped away.
  const match = evidence.match(/^(?:(?:(?:付款|支付|交易|下单|订单(?:创建)?|创建|消费|购买)(?:时间|日期)|(?:payment|transaction) (?:time|date)|paid at|order (?:time|date)|(?:order )?created at)\s*(?:[:：]|为|是)?\s*)?(\d{4})(?:[-/.]|\s*年\s*)(\d{1,2})(?:[-/.]|\s*月\s*)(\d{1,2})日?(?:(?:[T\s]+|\s*,\s*)(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/iu);
  if (!match) throw new Error('image-time');
  const [, year, month, day, hour, minute, second] = match;
  const two = (value) => String(value).padStart(2, '0');
  const date = `${year}-${two(month)}-${two(day)}`;
  const clock = hour === undefined ? undefined : `${two(hour)}:${minute}`;
  if (date !== input.localDate || clock !== input.localTime
    || (second !== undefined && Number(second) > 59)) throw new Error('image-time');
  return { second: second === undefined ? 0 : Number(second), showSeconds: second !== undefined };
}

export function imageExpenseTimeDisplay(input) {
  if (!input.imageEvidence) return { showSeconds: false, note: '' };
  if (input.timeMode === 'received') return {
    showSeconds: false, note: '图片未显示可用的消费时间，采用收到图片的时间。',
  };
  return { showSeconds: imageExpenseTimeParts(input).showSeconds,
    note: input.localTime === undefined ? '日期采用本次提供的日期，具体时分采用收到图片的时间。' : '' };
}

export function imageExpenseCurrencyNote(input) {
  return input.imageEvidence?.semanticVersion === 2 && input.imageEvidence.currencyDefaulted === true
    ? '图片未显示明确币种，按默认 SGD 处理。' : '';
}

export function validateImageExpense(input, inbound, { confirmed = false } = {}) {
  if (!normalizeImageAttachment(inbound.image) || !HASH.test(inbound.recipientKey ?? '')) throw new Error('image-source');
  const evidence = input.imageEvidence;
  if (evidence?.semanticVersion === 2) return validateSemanticImageExpense(input, { confirmed });
  if (evidence?.semanticVersion !== undefined) throw new Error('image-evidence');
  if (!evidence || typeof evidence !== 'object' || evidence.orderCount !== 1
    || !['paid', 'unclear'].includes(evidence.paymentStatus)
    || typeof evidence.amountAmbiguous !== 'boolean') throw new Error('image-payment');
  for (const field of ['totalEvidence', 'statusEvidence', 'currencyEvidence']) {
    if (typeof evidence[field] !== 'string' || !evidence[field].trim()
      || evidence[field].length > 160 || /[\r\n]/u.test(evidence[field])) throw new Error('image-evidence');
  }
  const totals = evidence.totalEvidence.replace(/(?<=\d),(?=\d{3}(?:\D|$))/gu, '').match(/\d+(?:\.\d+)?/gu) ?? [];
  if (totals.length !== 1 || !/^\d+(?:\.\d{1,2})?$/u.test(totals[0])
    || Number(totals[0]) !== Number(input.amount)
    || !/(?:实付|实际支付|支付金额|付款金额|合计|总计|total|amount paid)/iu.test(evidence.totalEvidence)) throw new Error('image-total');
  // An available refund action is not a refund that has happened or is pending.
  const paymentStatusText = evidence.statusEvidence.replace(/(?:可(?:以)?|支持|页面提供)申请退款|申请退款按钮/gu, '');
  if (/(?:待付款|未付款|未支付|支付失败|已关闭|退款|refund|unpaid|not paid|payment failed|\b(?:not approved|declined|reversed|voided)\b)/iu.test(paymentStatusText)) throw new Error('image-payment');
  // The model may cite the final amount actually paid instead of the page's
  // fulfilment heading. A payment method or an amount merely due is not proof.
  const approvedCardPayment = /^\s*(?:status\s*[:：]\s*)?approved\s*(?:$|[,，;；])/iu.test(paymentStatusText);
  const paid = evidence.paymentStatus === 'paid'
    && !/\b(?:pending|pre[ -]?authori[sz](?:ation|ed)|hold)\b/iu.test(paymentStatusText)
    && (/(?:已支付|支付成功|交易成功|已付款|待发货|待收货|交易完成|paid|payment successful)/iu.test(paymentStatusText)
      || /(?:实付款?|实际支付|amount paid)/iu.test(evidence.totalEvidence)
      || approvedCardPayment);
  const currency = input.currency;
  // This is the model's platform interpretation, not independently verified OCR.
  // Chinese commerce context can identify RMB; a bare shared yen symbol cannot.
  const chineseCommerceCurrency = currency === 'CNY'
    && /(?:中文|中国|国内|大陆)/u.test(evidence.currencyEvidence)
    && /(?:电商|购物|订单)/u.test(evidence.currencyEvidence)
    && /[¥￥]/u.test(evidence.currencyEvidence)
    && !/(?:JPY|日元|日本|円)/iu.test(evidence.currencyEvidence);
  const explicitCurrency = new RegExp(`\\b${currency}\\b`, 'iu').test(evidence.currencyEvidence)
    || (currency === 'CNY' && /人民币|RMB|淘宝|天猫/u.test(evidence.currencyEvidence))
    || (currency === 'SGD' && /新币|新元|S\$/u.test(evidence.currencyEvidence))
    || (currency === 'JPY' && /日元|日本円/u.test(evidence.currencyEvidence))
    || (currency === 'USD' && /美元|US\$/u.test(evidence.currencyEvidence));
  const ambiguousSymbol = evidence.currencyAmbiguous === true
    && ((/[¥￥]/u.test(evidence.currencyEvidence) && ['CNY', 'JPY'].includes(currency))
      || (/[$＄]/u.test(evidence.currencyEvidence) && ['SGD', 'USD', 'AUD', 'CAD', 'HKD', 'NZD', 'TWD'].includes(currency)));
  if (!explicitCurrency && !chineseCommerceCurrency && !ambiguousSymbol) throw new Error('image-currency');
  if (evidence.orderReference !== undefined && (typeof evidence.orderReference !== 'string'
    || evidence.orderReference.length > 160)) throw new Error('image-order');
  return { needsConfirmation: !confirmed && (!paid || evidence.amountAmbiguous || evidence.currencyAmbiguous === true),
    orderHash: evidence.orderReference?.trim() ? createHash('sha256').update(evidence.orderReference.trim()).digest('hex') : undefined };
}

function boundedEvidence(value, max = 320) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[\r\n\u0000]/u.test(value);
}

function validateSemanticImageExpense(input, { confirmed }) {
  const evidence = input.imageEvidence;
  if (evidence.orderCount !== 1) throw new Error('image-order');
  if (!['expense', 'unclear'].includes(evidence.expenseStatus)) throw new Error('image-payment');
  if (!boundedEvidence(evidence.statusEvidence)) throw new Error('image-evidence');
  if (!boundedEvidence(evidence.totalEvidence) || typeof evidence.amountAmbiguous !== 'boolean') throw new Error('image-total');
  if (!boundedEvidence(evidence.currencyEvidence) || typeof evidence.currencyAmbiguous !== 'boolean') throw new Error('image-currency');
  if (evidence.currencyDefaulted !== undefined && typeof evidence.currencyDefaulted !== 'boolean') throw new Error('image-currency');
  if (evidence.currencyDefaulted && (input.currency !== 'SGD' || evidence.currencyAmbiguous)) throw new Error('image-currency');
  // Missing purpose is informational; the core supplies the user's default comment.
  if (typeof evidence.purposeAmbiguous !== 'boolean'
    || (evidence.purposeEvidence && !boundedEvidence(evidence.purposeEvidence))
    || (input.comment && !boundedEvidence(input.comment, 255))) throw new Error('image-evidence');
  imageExpenseTimeParts(input);
  if (evidence.orderReference !== undefined && (typeof evidence.orderReference !== 'string'
    || evidence.orderReference.length > 160)) throw new Error('image-order');
  // Evidence is a model interpretation, not trusted OCR. Do not reclassify it
  // through keyword/locale regexes. Arithmetic, calendar validity, currency
  // accounts, transport authority and deduplication are enforced separately.
  return {
    needsConfirmation: !confirmed && (evidence.expenseStatus === 'unclear'
      || evidence.amountAmbiguous || evidence.currencyAmbiguous),
    orderHash: evidence.orderReference?.trim()
      ? createHash('sha256').update(evidence.orderReference.trim()).digest('hex') : undefined,
  };
}
