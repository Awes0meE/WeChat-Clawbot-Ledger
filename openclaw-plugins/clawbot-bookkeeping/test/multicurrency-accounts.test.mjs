import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareMulticurrencyAccounts, runMulticurrencyAccountPreparation } from '../../../scripts/prepare-multicurrency-accounts.mjs';
import { EzBookkeepingApi } from '../adapter.mjs';
const legacy = { id: 'old', name: '日常支出', type: 1, category: 1, icon: '1', color: '1e88e5', currency: 'SGD', balance: -12300 };
const plan = prepareMulticurrencyAccounts([legacy]);
const parent = { ...plan.payload, id: 'parent', subAccounts: plan.payload.subAccounts.map((child) => ({ ...child, id: `id-${child.currency}`, parentId: 'parent' })) };

test('provisioning plans preserve legacy account and make every currency a zero-balance child', () => {
  assert.equal(plan.action, 'create'); assert.equal(plan.payload.subAccounts.length, 159);
  assert.equal(plan.payload.currency, '---'); assert.equal(plan.payload.type, 2);
  assert.ok(plan.payload.subAccounts.every((a) => a.type === 1 && a.balance === 0 && a.category === 1));
  assert.equal(prepareMulticurrencyAccounts([legacy, parent]).action, 'already_complete');
  assert.equal(prepareMulticurrencyAccounts([legacy, parent]).sha256, plan.sha256);
  for (const accounts of [[legacy, { ...parent, hidden: true }], [legacy, { ...parent, subAccounts: parent.subAccounts.slice(0, 1) }], [{ ...legacy, currency: 'USD' }]]) assert.throws(() => prepareMulticurrencyAccounts(accounts));
});

test('default preparation is read-only; reviewed hash allows exactly one parent creation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-account-plan-'));
  const tokenPath = join(directory, 'token'); writeFileSync(tokenPath, 'synthetic-token');
  let created = false; const writes = [];
  const fetchImpl = async (url, options) => {
    if (options.method === 'POST') { writes.push({ url, body: JSON.parse(options.body) }); created = true; return new Response(JSON.stringify({ success: true, result: parent })); }
    return new Response(JSON.stringify({ success: true, result: created ? [legacy, parent] : [legacy] }));
  };
  const options = { serverBaseUrl: 'http://127.0.0.1:18888', tokenPath, fetchImpl };
  try {
    const receipt = await runMulticurrencyAccountPreparation(options); assert.equal(writes.length, 0);
    await assert.rejects(runMulticurrencyAccountPreparation({ ...options, applySha256: 'wrong' })); assert.equal(writes.length, 0);
    await runMulticurrencyAccountPreparation({ ...options, applySha256: receipt.planSha256 });
    assert.equal(writes.length, 1); assert.ok(writes[0].url.endsWith('/accounts/add.json'));
    await runMulticurrencyAccountPreparation({ ...options, applySha256: receipt.planSha256 }); assert.equal(writes.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('multi-account API summaries and history reject rows from outside their scope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-scope-'));
  const tokenPath = join(directory, 'token'); writeFileSync(tokenPath, 'synthetic-token');
  let response = [], requestCount = 0;
  const api = new EzBookkeepingApi({ serverBaseUrl: 'http://127.0.0.1:8888', tokenPath,
    fetchImpl: async (url) => {
      requestCount++; assert.equal(new URL(url).searchParams.get('account_ids'), 'a,b');
      return new Response(JSON.stringify({ success: true, result: response }));
    } });
  const options = { accounts: [{ id: 'a', currency: 'SGD' }, { id: 'b', currency: 'CNY' }], startTime: 100, endTime: 200 };
  try {
    const row = { type: 3, time: 150, categoryId: 'food', sourceAccountId: 'b', sourceAmount: 3500 };
    response = [row]; assert.equal((await api.listScopedExpenseTransactions(options))[0].currency, 'CNY');
    for (const invalid of [{ ...row, sourceAccountId: 'private' }, { ...row, time: 99 }, null]) {
      response = [invalid]; await assert.rejects(api.listScopedExpenseTransactions(options));
    }
    const before = requestCount;
    await assert.rejects(api.listScopedExpenseTransactions({ ...options, accounts: [{ id: 'a,b', currency: 'CNY' }] }));
    assert.equal(requestCount, before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
