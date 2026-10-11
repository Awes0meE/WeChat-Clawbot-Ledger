import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewImageExpense, applyImageReview } from '../image-review.mjs';
import { detailRegions, imageReviewDetails } from '../image-review-details.mjs';
import { PhotonImage } from '@silvia-odwyer/photon-node';

const pixel = new PhotonImage(Uint8Array.of(255, 255, 255, 255), 1, 1);
const REVIEW_PIXEL = Buffer.from(pixel.get_bytes_jpeg(95)); pixel.free();

const result = {
  decision: 'record', issue: 'none', amountBasis: 'transaction_amount', amount: '21.00', currency: 'BRL', currencyDefaulted: false,
  localDate: '2025-01-16', localTime: '23:45', localSecond: null, timeKind: 'payment',
  dateCandidates: ['2025-01-16'], dateBasis: 'visible_format',
  rawDate: '16 de Jan de 2025 23:45', totalEvidence: 'R$21,00 BRL', currencyEvidence: 'BRL visible',
  statusEvidence: 'Manual payment receipt', purposeEvidence: 'Meta ads', hasPurpose: true,
  comment: 'Meta广告', primaryCategory: '其他杂项', subcategory: '其他支出',
};
const input = { amount: '21.00', currency: 'BRL', timeMode: 'explicit',
  localDate: '2025-06-16', localTime: '23:45', timeEvidence: '16 de jun de 2025 23:45',
  primaryCategory: '学习进修', subcategory: '培训进修', comment: 'Meta广告',
  imageEvidence: { semanticVersion: 2, orderReference: 'private-order' } };

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-review-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'original.jpg');
  const buffer = Buffer.from([255, 216, 255, 10, 20, 30]);
  writeFileSync(path, buffer);
  const inbound = { content: '', recipientKey: 'a'.repeat(64), image: {
    path, type: 'image/jpeg', bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  } };
  const calls = [];
  const runtime = {
    media: { async getImageMetadata() { return { width: 768, height: 1024 }; },
      async resizeToJpeg(params) { calls.push(params); return REVIEW_PIXEL; } },
    mediaUnderstanding: { async extractStructuredWithModel(params) { calls.push(params); return { parsed: result }; } },
  };
  return { input, inbound, runtime, config: {}, isStillAuthorized: () => true, calls };
}

test('independent original-pixel review corrects date and category without passing the first model guess', async t => {
  const f = fixture(t);
  const reviewed = await reviewImageExpense(f);
  assert.equal(reviewed.localDate, '2025-01-16');
  assert.equal(reviewed.primaryCategory, '其他杂项');
  assert.equal(reviewed.imageEvidence.orderReference, 'private-order');
  assert.equal(f.calls[0].maxSide, 1024);
  assert.equal(f.calls[0].withoutEnlargement, true);
  assert.equal(f.calls[1].provider, 'codex');
  assert.equal(f.calls[1].model, 'gpt-5.6-sol');
  assert.equal(f.calls[1].input[1].text.includes('2025-06-16'), false);
  assert.equal(input.localDate, '2025-06-16');
});

test('missing purpose produces literal 无; missing clock does not inherit a previous guess', t => {
  const f = fixture(t);
  const reviewed = applyImageReview(input, f.inbound, { ...result, hasPurpose: false,
    purposeEvidence: '', comment: '', localTime: null, currency: 'SGD', currencyDefaulted: true });
  assert.equal(reviewed.comment, '无');
  assert.equal(reviewed.subcategory, '其他支出');
  assert.equal('localTime' in reviewed, false);
  assert.equal(reviewed.imageEvidence.currencyDefaulted, true);
});

test('date gaps, non-expenses and invalid reviewer results cannot become entries', t => {
  const f = fixture(t);
  assert.throws(() => applyImageReview(input, f.inbound, { ...result, decision: 'clarify', issue: 'date' }), /image-date/u);
  assert.throws(() => applyImageReview(input, f.inbound, { ...result, decision: 'not_expense' }), /image-payment/u);
  assert.throws(() => applyImageReview(input, f.inbound, { ...result, localTime: '23:45:00' }), /image-review/u);
  assert.throws(() => applyImageReview(input, f.inbound, { ...result, localSecond: 60 }), /image-review/u);
  assert.throws(() => applyImageReview(input, f.inbound, { ...result, amountBasis: 'item_price' }), /image-total/u);
});

test('a record decision cannot override unresolved date alternatives or a different selected date', t => {
  const f = fixture(t);
  for (const change of [
    { dateCandidates: ['2020-01-11', '2020-11-01'], localDate: '2020-01-11' },
    { dateBasis: 'unresolved' },
    { dateCandidates: [] },
    { dateCandidates: ['2025-06-16'] },
  ]) assert.throws(() => applyImageReview(input, f.inbound, { ...result, ...change }), /image-date/u);
  const clarified = applyImageReview(input, f.inbound, { ...result,
    dateBasis: 'user_date', dateCandidates: ['2020-01-11'], localDate: '2020-01-11', rawDate: '2020-01-11' });
  assert.equal(clarified.localDate, '2020-01-11');
});

test('changed source bytes fail before any model call', async t => {
  const f = fixture(t);
  writeFileSync(f.inbound.image.path, Buffer.from([255, 216, 255, 10, 20, 31]));
  await assert.rejects(reviewImageExpense(f), /image-source/u);
  assert.equal(f.calls.length, 0);
});

test('revoked authority and source changes during model work fail before returning a candidate', async t => {
  const f = fixture(t);
  let active = true;
  f.isStillAuthorized = () => active;
  f.runtime.mediaUnderstanding.extractStructuredWithModel = async () => { active = false; return { parsed: result }; };
  await assert.rejects(reviewImageExpense(f), /image-source/u);
  active = true;
  f.runtime.mediaUnderstanding.extractStructuredWithModel = async () => {
    writeFileSync(f.inbound.image.path, 'changed'); return { parsed: result };
  };
  await assert.rejects(reviewImageExpense(f), /image-source/u);
});

test('unavailable runtime or failed model review never silently falls back to the first guess', async t => {
  const f = fixture(t);
  await assert.rejects(reviewImageExpense({ ...f, runtime: {} }), /image-review/u);
  f.runtime.mediaUnderstanding.extractStructuredWithModel = async () => { throw new Error('model unavailable'); };
  await assert.rejects(reviewImageExpense(f), /image-review/u);
});

test('generic detail tiles cover both axes with overlap and keep the original bytes', async () => {
  for (const [w, h] of [[1296, 1827], [1827, 1296], [752, 2214], [2214, 752]]) {
    const regions = detailRegions(w, h);
    assert.equal(regions.length, Math.max(w, h) / Math.min(w, h) > 2.5 ? 3 : 6);
    // Rectangle membership changes only at an edge; check every partition cell.
    const xs = [...new Set(regions.flatMap(([l, , r]) => [l, r]))].sort((a, b) => a - b);
    const ys = [...new Set(regions.flatMap(([, t, , b]) => [t, b]))].sort((a, b) => a - b);
    assert.deepEqual([xs[0], xs.at(-1), ys[0], ys.at(-1)], [0, w, 0, h]);
    for (const x of xs.slice(0, -1)) for (const y of ys.slice(0, -1)) {
      assert.ok(regions.some(([l, t, r, b]) => l <= x && x < r && t <= y && y < b));
    }
  }
  const original = new PhotonImage(new Uint8Array(64 * 128 * 4).fill(255), 64, 128);
  let buffer;
  try { buffer = Buffer.from(original.get_bytes_jpeg(95)); } finally { original.free(); }
  const before = Buffer.from(buffer), calls = [];
  const images = await imageReviewDetails(buffer, async p => { calls.push(p); return p.buffer; });
  assert.equal(images.length, 7);
  assert.deepEqual(images[0], before);
  assert.deepEqual(buffer, before);
  assert.ok(calls.every(p => p.maxSide === 2048 && p.withoutEnlargement === false));
  assert.throws(() => detailRegions(10000, 10000), /Invalid/u);
});
