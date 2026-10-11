import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { validateImageExpense, readInboundImage, imageRunMatches, imageConfirmationSelection, imageExpenseTimeDisplay, imageExpenseCurrencyNote } from '../image-expense.mjs';
import { prepareExpenseConfirmation, recordExpense, recordConfirmedExpense, formatExpenseReceipt, imageExpenseKeys } from '../bookkeeping-core.mjs';
import { SqliteReceiptStore, trustedInboundMessageKey } from '../adapter.mjs';

const image = { path: '/synthetic/media/inbound/order.jpg', sha256: 'a'.repeat(64), bytes: 100, type: 'image/jpeg' };
const inbound = { image, imageAccountId: 'test-account', channel: 'test', messageId: 'order-1', content: '',
  timestamp: Date.now(), observedAt: Date.now(), timeSource: 'message', conversationKey: 'b'.repeat(64),
  recipientKey: 'c'.repeat(64), deliveryKey: 'd'.repeat(64) };
const input = { amount: '138.60', currency: 'CNY', primaryCategory: '衣服饰品', subcategory: '鞋帽包包', timeMode: 'received',
  imageEvidence: { paymentStatus: 'paid', statusEvidence: '待发货', totalEvidence: '实付款 ¥138.60',
    currencyEvidence: '淘宝中国订单', orderCount: 1, amountAmbiguous: false, orderReference: 'synthetic-shop:order-1' } };

const semanticInput = (overrides = {}) => ({ ...input, amount: '12.50', currency: 'EUR',
  timeMode: 'explicit', localDate: '2026-09-01', localTime: '13:20', timeEvidence: '1 Sep 2026 1:20 pm',
  comment: 'Cafe lunch', imageEvidence: { semanticVersion: 2, expenseStatus: 'expense',
    totalEvidence: 'Summe 12,50; Bar 20,00; Rückgeld 7,50', currencyEvidence: 'Euro receipt',
    statusEvidence: 'Issued cafe receipt with cash and change', purposeEvidence: 'Cafe lunch',
    timeKind: 'purchase', amountAmbiguous: false, currencyAmbiguous: false,
    dateAmbiguous: false, purposeAmbiguous: false, orderCount: 1, ...overrides } });

for (const [name, totalEvidence, currencyEvidence, timeEvidence] of [
  ['English receipt', 'Cash 20.00, change 7.50, total 12.50', 'Euro', '1 Sep 2026 1:20 PM'],
  ['German receipt', 'Summe 12,50 EUR', 'EUR', '01.09.2026 13:20 Uhr'],
  ['French invoice', 'Réglé 12,50 €', '€', '1 septembre 2026 à 13h20'],
  ['Chinese payment', '扣款十二元五角', '合成外币消费，EUR', '二〇二六年九月一日 下午一点二十分'],
  ['Japanese receipt', 'お支払い 12.50', 'ユーロ', '2026年9月1日 午後1時20分'],
  ['unlabelled transaction', '12.50', 'European currency context', '2026/9/1, 13:20'],
]) test(`semantic image uses model-normalized values without lexical gates: ${name}`, () => {
  const selected = { ...semanticInput({ totalEvidence, currencyEvidence }), timeEvidence };
  assert.equal(validateImageExpense(selected, inbound).needsConfirmation, false);
  assert.equal(prepareExpenseConfirmation({ input: selected, inbound }).amountMinor, 1250);
  assert.equal(prepareExpenseConfirmation({ input: selected, inbound }).time, Date.parse('2026-09-01T13:20:00+08:00') / 1000);
});

test('semantic images require date; typed math, calendar, source and version guards remain enforced', () => {
  for (const [change, reason] of [
    [{ totalEvidence: '' }, 'image-total'], [{ currencyEvidence: '' }, 'image-currency'],
    [{ dateAmbiguous: true }, 'image-date'], [{ timeKind: 'logistics' }, 'image-date'],
    [{ timeKind: 'unknown' }, 'image-date'], [{ orderCount: 2 }, 'image-order'],
    [{ expenseStatus: 'not_expense' }, 'image-payment'], [{ expenseStatus: 'paid' }, 'image-payment'],
    [{ localSecond: 60 }, 'image-date'], [{ localSecond: -1 }, 'image-date'],
    [{ semanticVersion: 3 }, 'image-evidence'],
  ]) assert.throws(() => validateImageExpense(semanticInput(change), inbound), new RegExp(reason));
  for (const change of [{ timeMode: 'received' }, { timeEvidence: '' }, { localDate: undefined },
    { localDate: '2026-02-30' }, { localTime: '24:00' }, { amount: '-2' },
    { amount: '0' }, { amount: '12.501' }, { currency: 'ZZZ' }]) {
    assert.throws(() => prepareExpenseConfirmation({ input: { ...semanticInput(), ...change }, inbound }));
  }
  assert.throws(() => validateImageExpense(semanticInput(), { ...inbound, image: undefined }), /image-source/u);
  assert.throws(() => prepareExpenseConfirmation({ input: semanticInput(), inbound: {
    ...inbound, timestamp: Date.parse('2026-09-01T12:00:00+08:00') } }));
});

test('missing image purpose records 无 without requiring confirmation or inventing a description', () => {
  for (const [evidence, comment] of [
    [{ purposeAmbiguous: true, purposeEvidence: 'No transaction description shown' }, 'Transfer to a person'],
    [{ purposeAmbiguous: false, purposeEvidence: '' }, undefined],
    [{ purposeAmbiguous: false, purposeEvidence: '' }, ''],
  ]) {
    const selected = { ...semanticInput(evidence), comment };
    assert.equal(validateImageExpense(selected, inbound).needsConfirmation, false);
    assert.equal(prepareExpenseConfirmation({ input: selected, inbound }).comment, '无');
  }
  const described = semanticInput();
  assert.equal(prepareExpenseConfirmation({ input: described, inbound }).comment, 'Cafe lunch');
  assert.throws(() => validateImageExpense(semanticInput({ purposeAmbiguous: true, dateAmbiguous: true }), inbound), /image-date/u);
  assert.throws(() => validateImageExpense(semanticInput({ purposeAmbiguous: true, expenseStatus: 'not_expense' }), inbound), /image-payment/u);
});

test('semantic ambiguity requires confirmation without requiring a literal paid label', () => {
  assert.equal(validateImageExpense(semanticInput(), inbound).needsConfirmation, false);
  for (const evidence of [{ amountAmbiguous: true }, { currencyAmbiguous: true }, { expenseStatus: 'unclear' }]) {
    const selected = semanticInput(evidence);
    assert.equal(validateImageExpense(selected, inbound).needsConfirmation, true);
    assert.equal(validateImageExpense(selected, inbound, { confirmed: true }).needsConfirmation, false);
  }
  assert.throws(() => validateImageExpense(semanticInput({ expenseStatus: 'not_expense' }), inbound, { confirmed: true }), /image-payment/u);
  assert.throws(() => validateImageExpense(semanticInput({ dateAmbiguous: true }), inbound, { confirmed: true }), /image-date/u);
});

test('semantic date-only and seconds retain their precision through the existing write path', async () => {
  const selected = semanticInput({ localSecond: 27 });
  const candidate = prepareExpenseConfirmation({ input: selected, inbound });
  assert.equal(candidate.time, Date.parse('2026-09-01T13:20:27+08:00') / 1000);
  assert.equal(imageExpenseTimeDisplay(selected).showSeconds, true);
  const dateOnly = { ...semanticInput(), localTime: undefined, timeEvidence: '1 September 2026' };
  assert.match(imageExpenseTimeDisplay(dateOnly).note, /具体时分采用收到图片/u);
  assert.throws(() => validateImageExpense({ ...selected, localTime: undefined }, inbound), /image-date/u);
});

test('image totals require a single final payment and explicit currency context', () => {
  assert.equal(validateImageExpense(input, inbound).needsConfirmation, false);
  assert.equal(validateImageExpense({ ...input, imageEvidence: { ...input.imageEvidence,
    totalEvidence: '实付 ¥138.60', statusEvidence: '待发货，可申请退款' } }, inbound).needsConfirmation, false);
  for (const currencyEvidence of ['中文购物订单、支付宝支付、¥', '中文电商订单页面、¥']) {
    assert.equal(validateImageExpense({ ...input, amount: '1234.56', imageEvidence: {
      ...input.imageEvidence, totalEvidence: '实付款 ¥1,234.56', currencyEvidence,
    } }, inbound).needsConfirmation, false);
  }
  for (const evidence of [
    { totalEvidence: '商品单价 138.60' }, { totalEvidence: '实付款 138.60 优惠10' },
    { totalEvidence: '实付款 138.600' }, { totalEvidence: '实付款 13.86' },
    { currencyEvidence: '¥' }, { currencyEvidence: '中文电商订单、日元 ¥' },
    { paymentStatus: 'unpaid', statusEvidence: '待付款' },
    { statusEvidence: '退款成功' }, { statusEvidence: '正在申请退款' }, { statusEvidence: 'payment failed' }, { orderCount: 2 },
  ]) assert.throws(() => validateImageExpense({ ...input, imageEvidence: { ...input.imageEvidence, ...evidence } }, inbound));
  assert.equal(validateImageExpense({ ...input, imageEvidence: { ...input.imageEvidence, amountAmbiguous: true } }, inbound).needsConfirmation, true);
  assert.equal(validateImageExpense({ ...input, imageEvidence: { ...input.imageEvidence, paymentStatus: 'unclear', statusEvidence: '状态不清' } }, inbound).needsConfirmation, true);
  assert.throws(() => validateImageExpense(input, { ...inbound, image: undefined }));
  assert.equal(validateImageExpense({ ...input, imageEvidence: { ...input.imageEvidence, currencyEvidence: '¥', currencyAmbiguous: true } }, inbound).needsConfirmation, true);
});

test('paid image evidence accepts equivalent Chinese commerce wording and actual paid totals', () => {
  for (const currencyEvidence of ['页面金额使用¥，支付方式为支付宝支付，订单为中国电商页面',
    '电商订单页面为中文，金额标为￥', '国内购物平台，收货地为新加坡，金额¥', '中文订单页面、¥']) {
    const actual = { ...input, imageEvidence: { ...input.imageEvidence, currencyEvidence,
      statusEvidence: '支付方式：支付宝支付；页面显示实付款¥138.60' } };
    assert.equal(validateImageExpense(actual, inbound).needsConfirmation, false);
    assert.equal(prepareExpenseConfirmation({ input: actual, inbound }).amountMinor, 13860);
  }
  for (const totalEvidence of ['合计 ¥138.60', '付款金额 ¥138.60']) {
    assert.equal(validateImageExpense({ ...input, imageEvidence: { ...input.imageEvidence,
      statusEvidence: '支付方式：支付宝支付', totalEvidence } }, inbound).needsConfirmation, true,
    'a payment method and amount due are not a completed payment');
  }
  for (const statusEvidence of ['待付款', '未支付', '支付失败', '退款成功', '正在申请退款']) {
    assert.throws(() => validateImageExpense({ ...input, imageEvidence: { ...input.imageEvidence, statusEvidence } }, inbound),
      /image-payment/u, 'explicit negative status overrides an actual-paid amount label');
  }
  for (const currencyEvidence of ['¥', '支付宝支付，¥', '中文电商订单、日元 ¥', '日本购物平台 ¥']) {
    assert.throws(() => validateImageExpense({ ...input, imageEvidence: { ...input.imageEvidence, currencyEvidence } }, inbound), /image-currency/u);
  }
  assert.equal(validateImageExpense({ ...input, imageEvidence: { ...input.imageEvidence,
    paymentStatus: 'unclear', statusEvidence: '付款状态不清' } }, inbound).needsConfirmation, true);
});

test('image payment and order timestamps normalize common dates and preserve seconds', () => {
  const explicit = { ...input, timeMode: 'explicit', localDate: '2026-09-01', localTime: '13:20' };
  for (const timeEvidence of ['支付时间 2026-09-01 13:20:45', '付款时间：2026年9月1日 13时20分45秒',
    '下单时间 2026/9/1 13:20:45', '订单创建时间 2026.09.01 13:20:45', '创建时间 2026-09-01 13:20:45',
    'Payment time: 2026-09-01 13:20:45']) {
    const selected = { ...explicit, timeEvidence };
    const candidate = prepareExpenseConfirmation({ input: selected, inbound });
    assert.equal(candidate.time, Date.parse('2026-09-01T13:20:45+08:00') / 1000);
    const display = imageExpenseTimeDisplay(selected);
    assert.equal(display.showSeconds, true);
    assert.match(formatExpenseReceipt({ ...selected, ...candidate, ...display }), /2026\/09\/01 13:20:45/u);
  }
  assert.equal(prepareExpenseConfirmation({ input: { ...explicit, timeEvidence: '订单时间 2026-09-01 13:20' }, inbound }).time,
    Date.parse('2026-09-01T13:20:00+08:00') / 1000);
});

test('image dates without clocks disclose fallback; absent dates preserve original receive time', () => {
  const source = { ...inbound, timestamp: Date.parse('2026-09-30T20:21:22+08:00') };
  const selected = { ...input, timeMode: 'explicit', localDate: '2026-09-01', timeEvidence: '付款日期为2026年9月1日' };
  assert.equal(prepareExpenseConfirmation({ input: selected, inbound: source }).time,
    Date.parse('2026-09-01T20:21:00+08:00') / 1000);
  assert.match(imageExpenseTimeDisplay(selected).note, /具体时分采用收到图片/u);
  assert.equal(prepareExpenseConfirmation({ input, inbound: source }).time, source.timestamp / 1000);
  assert.match(imageExpenseTimeDisplay(input).note, /未显示可用的消费时间/u);
});

test('unlabelled card purchase timestamps preserve comma separators and exact seconds', () => {
  const explicit = { ...input, timeMode: 'explicit', localDate: '2026-09-01', localTime: '13:20' };
  for (const timeEvidence of ['2026/9/1, 13:20', '2026/09/01，13:20', '2026-09-01 13:20',
    '2026-09-01T13:20', '2026年9月1日, 13:20', '交易时间：2026/9/1, 13:20',
    'Transaction time: 2026/9/1, 13:20']) {
    assert.equal(prepareExpenseConfirmation({ input: { ...explicit, timeEvidence }, inbound }).time,
      Date.parse('2026-09-01T13:20:00+08:00') / 1000);
  }
  const seconds = { ...explicit, timeEvidence: '2026/9/1, 13:20:45' };
  assert.equal(prepareExpenseConfirmation({ input: seconds, inbound }).time,
    Date.parse('2026-09-01T13:20:45+08:00') / 1000);
  assert.equal(imageExpenseTimeDisplay(seconds).showSeconds, true);
  for (const timeEvidence of ['发货时间 2026/9/1, 13:20', 'Delivery time: 2026/9/1, 13:20',
    '预计到货 2026/9/1, 13:20', '2026/9/1, 13:21', '2026/9/2, 13:20',
    '2026/9/1, 13:20 2026/9/2, 13:20', '2026/9/1,', '13:20', '9/1, 13:20',
    '2026/9/1, 13:20 PM', '2026/9/1, 13:20:60']) {
    assert.throws(() => prepareExpenseConfirmation({ input: { ...explicit, timeEvidence }, inbound }),
      error => error.rejectionReason === 'time');
  }
  assert.throws(() => prepareExpenseConfirmation({ input: seconds,
    inbound: { ...inbound, timestamp: Date.parse('2026-09-01T13:15:30+08:00') } }),
  error => error.rejectionReason === 'time');
});

test('approved card transactions are paid but negative or provisional statuses cannot bypass confirmation', () => {
  const card = { ...input, currency: 'SGD', imageEvidence: { ...input.imageEvidence,
    currencyEvidence: 'SGD: transaction total', totalEvidence: 'Total SGD 138.60' } };
  for (const statusEvidence of ['Status: Approved', 'Status: Approved，Visa Debit Card', 'Approved', 'approved; debit card']) {
    assert.equal(validateImageExpense({ ...card, imageEvidence: { ...card.imageEvidence, statusEvidence } }, inbound).needsConfirmation, false);
  }
  for (const statusEvidence of ['Status: Not Approved', 'Declined', 'Approved; Reversed', 'Approved; Voided',
    'Refund status: Approved', 'Status: Approved; refund pending']) {
    assert.throws(() => validateImageExpense({ ...card, imageEvidence: { ...card.imageEvidence, statusEvidence } }, inbound), /image-payment/u);
  }
  for (const statusEvidence of ['Visa Debit Card', 'Approval requested', 'Status: Pending', 'Status: Unapproved',
    'Preauthorization: Approved', 'Approved; pre-authorized', 'Approved; hold', 'Approved; pending']) {
    assert.equal(validateImageExpense({ ...card, imageEvidence: { ...card.imageEvidence, statusEvidence } }, inbound).needsConfirmation, true);
  }
  for (const evidence of [{ paymentStatus: 'unclear' }, { amountAmbiguous: true }, { currencyAmbiguous: true }]) {
    assert.equal(validateImageExpense({ ...card, imageEvidence: { ...card.imageEvidence,
      statusEvidence: 'Status: Approved', ...evidence } }, inbound).needsConfirmation, true);
  }
});

test('image timestamps reject logistics, conflicting evidence, invalid dates and future seconds', () => {
  const source = { ...inbound, timestamp: Date.parse('2026-09-01T13:15:30+08:00') };
  const explicit = { ...input, timeMode: 'explicit', localDate: '2026-09-01', localTime: '13:20' };
  for (const timeEvidence of ['收货时间 2026-09-01 13:20', '发货时间 2026-09-01 13:20',
    '预计到货时间 2026-09-01 13:20', '支付时间 2026-09-02 13:20', '支付时间 2026-09-01 13:21',
    '支付时间 2026-09-01 13:20:60', '支付时间 2026-09-01 13:20:31',
    '创建时间 2026-09-01 13:20 支付时间 2026-09-01 13:20', '支付时间 2026-09-01 13:20 PM']) {
    assert.throws(() => prepareExpenseConfirmation({ input: { ...explicit, timeEvidence }, inbound: source }),
      error => error.rejectionReason === 'time');
  }
  for (const localDate of ['2026-02-30', '2026-13-01']) {
    assert.throws(() => prepareExpenseConfirmation({ input: { ...explicit, localDate,
      timeEvidence: `付款时间 ${localDate} 13:20` }, inbound }));
  }
  assert.throws(() => prepareExpenseConfirmation({ input: { ...explicit, localTime: undefined,
    timeEvidence: '付款时间 2026-09-01 13:20' }, inbound }));
});

test('confirmed image write retains original date and seconds after reopening durable proposal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clawbot-image-time-'));
  let store = new SqliteReceiptStore(join(root, 'receipts.sqlite'));
  const selected = { ...input, timeMode: 'explicit', localDate: '2026-09-01', localTime: '13:20',
    timeEvidence: '订单创建时间 2026/09/01 13:20:45' };
  const expectedTime = Date.parse('2026-09-01T13:20:45+08:00') / 1000;
  let written;
  try {
    const sourceMessageKey = trustedInboundMessageKey(inbound.channel, inbound.messageId);
    const now = Date.now();
    store.enqueueTrustedInbound(['lookup'], sourceMessageKey, inbound, now + 600000, { isRealInbound: true });
    const candidate = prepareExpenseConfirmation({ input: selected, inbound });
    const stored = store.storeImageProposal(inbound.conversationKey,
      { sourceMessageKey, input: selected, sourceInbound: inbound, resolvedTime: candidate.time }, now + 600000);
    store.close(); store = new SqliteReceiptStore(join(root, 'receipts.sqlite'));
    const { proposal } = store.consumeImageOrTextConfirmation(inbound.conversationKey, 'e'.repeat(64), stored.id, now + 1000);
    const api = { resolveAccountId: async () => 'a', resolveExpenseCategoryId: async () => 'c',
      addTransaction: async (body) => { written = body; return { id: 'synthetic' }; } };
    await assert.rejects(recordConfirmedExpense({ api, store, input: proposal.input, inbound: proposal.sourceInbound,
      resolvedTime: proposal.resolvedTime - 45 }));
    assert.equal(written, undefined);
    const result = await recordConfirmedExpense({ api, store, input: proposal.input, inbound: proposal.sourceInbound,
      resolvedTime: proposal.resolvedTime });
    assert.equal(written.time, expectedTime); assert.equal(result.time, expectedTime);
    assert.equal(written.utcOffset, 480);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('only a bounded real inbound file and exact channel identity can bind image input', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-image-source-')));
  try {
    mkdirSync(join(root, 'media', 'inbound'), { recursive: true });
    const path = join(root, 'media', 'inbound', 'one.jpg');
    writeFileSync(path, Buffer.from([255, 216, 255, 10]));
    const event = { messageId: 'synthetic-id', media: [{ path, messageId: 'synthetic-id' }] };
    const trusted = readInboundImage(event, root);
    assert.equal(trusted.bytes, 4);
    assert.equal(readInboundImage({ ...event, media: [...event.media, ...event.media] }, root), undefined);
    assert.equal(readInboundImage({ ...event, replyToIsQuote: true }, root), undefined);
    assert.equal(readInboundImage({ ...event, media: [{ path }] }, root), undefined);
    const link = join(root, 'media', 'inbound', 'link.jpg'); symlinkSync(path, link);
    assert.equal(readInboundImage({ ...event, media: [{ path: link, messageId: event.messageId }] }, root), undefined);
    const prompt = 'Conversation info: ⟦openclaw:ctx⟧\n```json\n' + JSON.stringify({ message_id: inbound.messageId, source_modality: 'image', sender: { id: 'synthetic-owner' } })
      + '\n```\n\n[media attached: media://inbound/one.jpg (image/*)]\n[Image]';
    const source = { ...inbound, image: trusted, recipientKey: createHash('sha256').update('recipient\u0000test\u0000synthetic-owner').digest('hex') };
    const storage = globalThis[Symbol.for('clawbot.weixin.inbound-image-context.v1')] ??= new AsyncLocalStorage();
    const identity = { messageId: inbound.messageId, imagePath: path, accountId: inbound.imageAccountId, senderId: 'synthetic-owner' };
    assert.equal(imageRunMatches(source, { imagesCount: 1, prompt }), false, 'forged prompt cannot mint transport identity');
    assert.equal(storage.run(identity, () => imageRunMatches(source, {})), true);
    for (const mismatch of [{ messageId: 'other' }, { imagePath: '/other' }, { accountId: 'other' }, { senderId: 'other' }]) {
      assert.equal(storage.run({ ...identity, ...mismatch }, () => imageRunMatches(source, {})), false);
    }
    assert.equal(imageRunMatches(source, {}), false, 'dispatch context cannot leak after completion');
    writeFileSync(path, 'not an image');
    assert.equal(readInboundImage(event, root), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('image links deduplicate across stores including unknown outcomes; order repeats need confirmation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clawbot-image-dedupe-'));
  const store = new SqliteReceiptStore(join(root, 'receipts.sqlite'));
  let writes = 0;
  const api = { resolveAccountId: async () => 'a', resolveExpenseCategoryId: async () => 'c', transactionExists: async () => true,
    addTransaction: async () => { writes++; return { id: 'synthetic' }; } };
  try {
    await recordExpense({ api, store, input, inbound });
    const again = await recordExpense({ api, store, input, inbound: { ...inbound, messageId: 'resend', conversationKey: '9'.repeat(64) } });
    assert.equal(again.status, 'duplicate'); assert.equal(writes, 1);
    const sameOrder = { ...inbound, messageId: 'second-image', image: { ...image, sha256: 'f'.repeat(64) } };
    assert.equal((await recordExpense({ api, store, input, inbound: sameOrder })).status, 'duplicate');
    await recordConfirmedExpense({ api, store, input, inbound: sameOrder });
    assert.equal(writes, 2);
    const unknown = { ...inbound, messageId: 'unknown', image: { ...image, sha256: '1'.repeat(64) } };
    const unknownInput = { ...input, imageEvidence: { ...input.imageEvidence, orderReference: 'unknown-order' } };
    await assert.rejects(recordExpense({ api: { ...api, addTransaction: async () => { throw Error('timeout'); } }, store, input: unknownInput, inbound: unknown }));
    const reopened = new SqliteReceiptStore(join(root, 'receipts.sqlite'));
    try { assert.equal((await recordExpense({ api, store: reopened, input: unknownInput, inbound: { ...unknown, messageId: 'unknown-resend' } })).previousStatus, 'unknown'); }
    finally { reopened.close(); }
    assert.equal(writes, 2);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('deleted image expenses can be reentered under a new message, preserving old receipts and confirmation tombstones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clawbot-image-deleted-'));
  let store = new SqliteReceiptStore(join(root, 'receipts.sqlite'));
  const live = new Set(); let writes = 0, lookups = 0;
  const api = { resolveAccountId: async () => 'a', resolveExpenseCategoryId: async () => 'c',
    transactionExists: async id => { lookups++; return live.has(id); },
    addTransaction: async () => { const id = `expense-${++writes}`; live.add(id); return { id }; } };
  try {
    const first = await recordExpense({ api, store, input, inbound });
    const originalReceipt = store.receipt('test:order-1');
    store.consumePendingExpenseConfirmation(inbound.conversationKey, '8'.repeat(64));
    live.delete(first.transactionId);
    assert.equal((await recordExpense({ api, store, input, inbound })).status, 'duplicate', 'same message remains permanently deduplicated');
    assert.equal(lookups, 0);
    store.close(); store = new SqliteReceiptStore(join(root, 'receipts.sqlite'));
    const second = await recordExpense({ api, store, input, inbound: { ...inbound, messageId: 'resent-after-delete' } });
    assert.equal(second.status, 'created'); assert.equal(writes, 2);
    assert.equal(live.size, 1);
    assert.deepEqual(store.receipt('test:order-1'), originalReceipt);
    assert.equal(store.database.prepare('SELECT count(*) AS n FROM processed_expense_confirmations').get().n, 1);
    const keys = imageExpenseKeys(input, inbound);
    assert.equal(store.imageReceiptLink(keys.attachmentKey).receiptKey, 'test:resent-after-delete');
    assert.equal(store.imageReceiptLink(keys.orderKey).receiptKey, 'test:resent-after-delete');
    assert.equal((await recordExpense({ api, store, input, inbound: { ...inbound, messageId: 'resent-again' } })).status, 'duplicate');
    assert.equal(writes, 2);
    live.delete(second.transactionId);
    assert.equal((await recordExpense({ api, store, input, inbound })).status, 'duplicate');
    assert.equal(store.imageReceiptLink(keys.attachmentKey).receiptKey, 'test:resent-after-delete', 'old transport replay cannot retire a newer link');
    assert.equal((await recordExpense({ api, store, input, inbound: { ...inbound, messageId: 'third-after-delete' } })).status, 'created');
    assert.equal(writes, 3);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('image lookup failures and uncertain writes retain deduplication without claiming a resend', async () => {
  const store = new SqliteReceiptStore(':memory:'); let writes = 0;
  const api = { resolveAccountId: async () => 'a', resolveExpenseCategoryId: async () => 'c',
    transactionExists: async () => { throw Error('network unavailable'); },
    addTransaction: async () => { writes++; return { id: 'expense' }; } };
  const resend = { ...inbound, messageId: 'lookup-failed' };
  try {
    await recordExpense({ api, store, input, inbound });
    const link = store.imageReceiptLink(imageExpenseKeys(input, inbound).attachmentKey);
    await assert.rejects(recordExpense({ api, store, input, inbound: resend }), e => e.rejectionReason === 'image_lookup');
    assert.equal(store.receipt('test:lookup-failed'), undefined);
    assert.deepEqual(store.imageReceiptLink(imageExpenseKeys(input, inbound).attachmentKey), link);
    await assert.rejects(recordExpense({ api: { ...api, transactionExists: async () => false }, store, input,
      inbound: resend, validateBeforeWrite: () => false }), e => e.rejectionReason === 'image_lookup');
    assert.deepEqual(store.imageReceiptLink(imageExpenseKeys(input, inbound).attachmentKey), link);
    store.uncertain('test:order-1', { status: 'unknown' });
    assert.equal((await recordExpense({ api, store, input, inbound: resend })).previousStatus, 'unknown');
    assert.equal(writes, 1);
  } finally { store.close(); }
});

test('a different screenshot of a deleted order is not blocked by the old order reference', async () => {
  const store = new SqliteReceiptStore(':memory:'); let writes = 0;
  const api = { resolveAccountId: async () => 'a', resolveExpenseCategoryId: async () => 'c',
    transactionExists: async () => false, addTransaction: async () => ({ id: `expense-${++writes}` }) };
  try {
    await recordExpense({ api, store, input, inbound });
    const newer = { ...inbound, messageId: 'different-screenshot', image: { ...image, sha256: 'e'.repeat(64) } };
    assert.equal((await recordExpense({ api, store, input, inbound: newer })).status, 'created');
    assert.equal(writes, 2);
    assert.equal(store.imageReceiptLink(imageExpenseKeys(input, newer).orderKey).receiptKey, 'test:different-screenshot');
    assert.equal(store.receipt('test:order-1').status, 'created');
  } finally { store.close(); }
});

test('concurrent deletion checks cannot retire a newer image claim or write two replacements', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clawbot-image-race-'));
  const a = new SqliteReceiptStore(join(root, 'receipts.sqlite')), b = new SqliteReceiptStore(join(root, 'receipts.sqlite'));
  let writes = 0; const waiting = [];
  const api = { resolveAccountId: async () => 'a', resolveExpenseCategoryId: async () => 'c',
    transactionExists: async () => new Promise(resolve => waiting.push(resolve)),
    addTransaction: async () => ({ id: `expense-${++writes}` }) };
  try {
    await recordExpense({ api, store: a, input, inbound });
    const one = recordExpense({ api, store: a, input, inbound: { ...inbound, messageId: 'race-one' } });
    const two = recordExpense({ api, store: b, input, inbound: { ...inbound, messageId: 'race-two' } });
    assert.equal(waiting.length, 2);
    waiting[0](false);
    assert.equal((await one).status, 'created');
    waiting[1](false);
    // The late lookup sees the new claim; any subsequent lookup says it exists.
    api.transactionExists = async () => true;
    assert.equal((await two).status, 'duplicate');
    assert.equal(writes, 2);
    assert.equal(a.imageReceiptLink(imageExpenseKeys(input, inbound).attachmentKey).receiptKey, 'test:race-one');
  } finally { a.close(); b.close(); rmSync(root, { recursive: true, force: true }); }
});

test('numbered confirmation parser rejects corrections and image queue expiry cannot revive', () => {
  assert.deepEqual(imageConfirmationSelection('确认第12笔。'), { decision: 'confirm', proposalId: 12 });
  for (const text of ['确认第12笔改成20元', '取消第1笔再记2元', '全部确认', '确认第0笔']) assert.equal(imageConfirmationSelection(text), undefined);
  const root = mkdtempSync(join(tmpdir(), 'clawbot-image-expiry-'));
  const store = new SqliteReceiptStore(join(root, 'receipts.sqlite'));
  try {
    const sourceMessageKey = trustedInboundMessageKey(inbound.channel, inbound.messageId);
    store.enqueueTrustedInbound(['lookup'], sourceMessageKey, inbound, Date.now() + 600000, { isRealInbound: true });
    const proposal = { sourceMessageKey, sourceInbound: inbound, input, resolvedTime: Math.floor(inbound.timestamp / 1000) };
    const now = Date.now(), stored = store.storeImageProposal(inbound.conversationKey, proposal, now + 1000, now);
    const resendInbound = { ...inbound, messageId: 'pending-resend' };
    const resendKey = trustedInboundMessageKey(inbound.channel, resendInbound.messageId);
    store.enqueueTrustedInbound(['lookup'], resendKey, resendInbound, now + 600000, { isRealInbound: true });
    assert.deepEqual(store.storeImageProposal(inbound.conversationKey, { ...proposal, sourceMessageKey: resendKey,
      sourceInbound: resendInbound }, now + 1000, now), { id: stored.id, status: 'duplicate' });
    assert.equal(store.consumeImageOrTextConfirmation(inbound.conversationKey, 'e'.repeat(64), stored.id, now + 1001).status, 'expired');
    assert.equal(store.storeImageProposal(inbound.conversationKey, proposal, now + 100000, now + 1002).status, 'expired');
    assert.equal(store.consumeImageOrTextConfirmation('f'.repeat(64), '2'.repeat(64), stored.id, now).status, 'missing');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});


test('user-defaulted image currency is SGD, disclosed, and cannot mask explicit ambiguity', () => {
  const selected = { ...semanticInput({ currencyDefaulted: true, currencyEvidence: 'No currency shown; user default SGD' }), currency: 'SGD' };
  assert.equal(validateImageExpense(selected, inbound).needsConfirmation, false);
  assert.match(imageExpenseCurrencyNote(selected), /默认 SGD/u);
  assert.equal(imageExpenseCurrencyNote(semanticInput()), '');
  assert.throws(() => validateImageExpense({ ...selected, currency: 'USD' }, inbound), /image-currency/u);
  assert.throws(() => validateImageExpense({ ...selected, imageEvidence: { ...selected.imageEvidence, currencyAmbiguous: true } }, inbound), /image-currency/u);
  assert.throws(() => validateImageExpense({ ...selected, imageEvidence: { ...selected.imageEvidence, currencyDefaulted: 'yes' } }, inbound), /image-currency/u);
});


test('a clear receipt date does not require a payment or order subtype', () => {
  const selected = semanticInput({ timeKind: 'expense', amountAmbiguous: true });
  assert.equal(validateImageExpense(selected, inbound).needsConfirmation, true);
  const candidate = prepareExpenseConfirmation({ input: selected, inbound });
  assert.equal(candidate.time, Date.parse('2026-09-01T13:20:00+08:00') / 1000);
  assert.equal(candidate.amountMinor, 1250);
  assert.throws(() => validateImageExpense({ ...selected, imageEvidence: { ...selected.imageEvidence, dateAmbiguous: true } }, inbound), /image-date/u);
  assert.throws(() => validateImageExpense({ ...selected, imageEvidence: { ...selected.imageEvidence, timeKind: 'logistics' } }, inbound), /image-date/u);
});
