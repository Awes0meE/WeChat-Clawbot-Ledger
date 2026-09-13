import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function loadCorpus(path = new URL('./wechat-bookkeeping.json', import.meta.url)) {
  const corpus = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.timezone, 'Asia/Singapore');
  assert.equal(corpus.defaultCurrency, 'SGD');
  assert.ok(Array.isArray(corpus.cases) && corpus.cases.length > 0);
  const seen = new Map();
  for (const c of corpus.cases) {
    assert.match(c.id, /^WX-\d{3,}$/u);
    assert.ok(!seen.has(c.id), `Duplicate ${c.id}`);
    assert.equal(typeof c.group, 'string', `${c.id}: group`);
    assert.ok(typeof c.message === 'string' && c.message.trim(), `${c.id}: message`);
    assert.ok(['record', 'prepare', 'cancel', 'query', 'no_write'].includes(c.expected?.action), `${c.id}: action`);
    if (c.conversation !== undefined) assert.match(c.conversation, /^[a-z0-9-]+$/u);
    const e = c.expected;
    for (const key of Object.keys(e)) {
      assert.ok(['action', 'amount', 'amountOneOf', 'currency', 'dayOffset', 'replyContains', 'category', 'commentEquals', 'localDate', 'localTime'].includes(key), `${c.id}: unknown expectation ${key}`);
    }
    if (e.amount !== undefined) assert.match(e.amount, /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u);
    if (e.currency !== undefined) assert.match(e.currency, /^[A-Z]{3}$/u);
    if (e.amountOneOf !== undefined) {
      assert.equal(e.action, 'prepare');
      assert.ok(Array.isArray(e.amountOneOf) && e.amountOneOf.length > 1);
      for (const amount of e.amountOneOf) assert.match(amount, /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u);
    }
    if (e.category !== undefined) assert.ok(Array.isArray(e.category) && e.category.length === 2 && e.category.every((v) => typeof v === 'string' && v));
    if (e.commentEquals !== undefined) assert.equal(typeof e.commentEquals, 'string');
    if (e.localDate !== undefined) assert.match(e.localDate, /^\d{4}-\d{2}-\d{2}$/u);
    if (e.localTime !== undefined) assert.match(e.localTime, /^(?:[01]\d|2[0-3]):[0-5]\d$/u);
    if (e.dayOffset !== undefined) assert.ok(Number.isInteger(e.dayOffset) && e.dayOffset <= 0);
    if (e.replyContains !== undefined) assert.ok(Array.isArray(e.replyContains) && e.replyContains.every((p) => typeof p === 'string' && p.length));
    if (e.action === 'record') assert.ok(e.amount && e.currency, `${c.id}: expected write amount/currency required`);
    if (e.action === 'prepare') assert.ok((e.amount || e.amountOneOf) && e.currency, `${c.id}: candidate required`);
    if (c.replayMessageIdFrom) {
      const source = seen.get(c.replayMessageIdFrom);
      assert.ok(source && source.message === c.message && source.conversation === c.conversation, `${c.id}: invalid replay source`);
      assert.equal(e.action, 'no_write');
    }
    seen.set(c.id, c);
  }
  return corpus;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const corpus = loadCorpus();
  console.log(JSON.stringify({ valid: true, cases: corpus.cases.length, groups: [...new Set(corpus.cases.map((c) => c.group))] }));
}
