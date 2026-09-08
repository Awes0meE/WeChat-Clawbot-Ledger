import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolveDeploymentProfile, TEST_PATHS } from '/opt/clawbot/plugins/clawbot-bookkeeping/deployment-profile.mjs';
import { EzBookkeepingApi, SqliteReceiptStore } from '/opt/clawbot/plugins/clawbot-bookkeeping/adapter.mjs';
import { recordExpense } from '/opt/clawbot/plugins/clawbot-bookkeeping/bookkeeping-core.mjs';
import { normalizeExpenseHistoryQuery, formatExpenseHistory } from '/opt/clawbot/plugins/clawbot-bookkeeping/expense-history.mjs';

const root = '/var/lib/clawbot-test';
const config = JSON.parse(readFileSync(`${root}/openclaw/openclaw.json`));
const deployment = resolveDeploymentProfile(config.plugins.entries['clawbot-bookkeeping'].config, config);
const origin = deployment.origin;
const token = readFileSync(TEST_PATHS.tokenPath, 'utf8').trim();
async function request(path, body) {
  const response = await fetch(`${origin}/api/v1/${path}`, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Timezone-Name': 'Asia/Singapore' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(`TEST_API_FAILED:${path}:${response.status}`);
  return payload.result;
}
const accounts = await request('accounts/list.json');
let account = accounts.find((a) => a.name === '日常支出');
assert.ok(accounts.length <= 1, 'Unexpected test accounts');
if (!account) account = await request('accounts/add.json', { name: '日常支出', category: 1, type: 1, icon: '1', color: '1e88e5', currency: 'SGD', balance: 0, balanceTime: 0, comment: 'Clawbot isolated P1 fixture' });
const catalog = JSON.parse(readFileSync('/opt/clawbot/config/expense-categories.json'));
let categories = (await request('transaction/categories/list.json'))['2'] ?? [];
for (const primary of catalog.categories) {
  let category = categories.find((c) => c.name === primary.name && c.parentId === '0');
  if (!category) category = await request('transaction/categories/add.json', { name: primary.name, type: 2, parentId: '0', icon: '1', color: 'ff6b22', comment: '' });
  for (const name of primary.subcategories) {
    if (!(category.subCategories ?? []).some((c) => c.name === name)) await request('transaction/categories/add.json', { name, type: 2, parentId: category.id, icon: '1', color: 'ff6b22', comment: '' });
  }
}
categories = (await request('transaction/categories/list.json'))['2'];
assert.equal(categories.length, 11); assert.equal(categories.flatMap((c) => c.subCategories ?? []).length, 45);
const api = new EzBookkeepingApi({ serverBaseUrl: origin, tokenPath: TEST_PATHS.tokenPath, deployment });
assert.equal(await api.resolveAccountId('日常支出'), account.id);
const state = new SqliteReceiptStore(TEST_PATHS.stateDbPath);
const fixturePath = `${root}/receipts/p1-fixture.json`;
const saved = existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath)) : null;
const now = saved?.receivedAt ?? Date.now();
const inbound = { channel: 'openclaw-weixin', messageId: 'clawbot-p1-expense-v1', senderId: 'clawbot-test-owner', content: '午饭0.01，备注P1隔离验收', timestamp: now };
const input = { amount: '0.01', currency: 'SGD', timeMode: 'received', primaryCategory: '食品酒水', subcategory: '早午晚餐' };
const options = { input, inbound, api, store: state, accountName: '日常支出', ledgerDisplayName: '日常账本', now };
const first = await recordExpense(options);
assert.equal(first.status, saved ? 'duplicate' : 'created');
if (!saved) writeFileSync(fixturePath, JSON.stringify({ receivedAt: now, transactionId: first.transactionId }), { mode: 0o600 });
assert.equal((await recordExpense(options)).status, 'duplicate');
state.close();
const reopened = new SqliteReceiptStore(TEST_PATHS.stateDbPath);
assert.equal((await recordExpense({ ...options, store: reopened })).status, 'duplicate');
reopened.close();

const mcpToken = readFileSync(TEST_PATHS.mcpTokenPath, 'utf8').trim();
assert.notEqual(token, mcpToken);
let session;
async function mcp(method, params, id) {
  const response = await fetch(`${origin}/mcp`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${mcpToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-03-26' } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id === undefined ? {} : { id }) }) });
  session = response.headers.get('mcp-session-id') ?? session;
  if (!response.ok) throw new Error(`TEST_MCP_FAILED:${response.status}`);
  const text = await response.text(); if (!text) return;
  const json = text.startsWith('data:') || text.startsWith('event:') ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5))).find((x) => x.id === id) : JSON.parse(text);
  if (json.error) throw new Error('TEST_MCP_RPC_FAILED');
  return json.result;
}
await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'clawbot-isolated-p1', version: '1.0.0' } }, 1);
await mcp('notifications/initialized', {});
const tools = (await mcp('tools/list', {}, 2)).tools;
const query = tools.find((t) => t.name === 'query_transactions'); assert.ok(query);
const historyQuery = normalizeExpenseHistoryQuery({ start_time: '2020-01-01T00:00:00Z', end_time: new Date(Date.now() + 60_000).toISOString(), count: 100 }, '日常支出');
assert.equal(historyQuery.count, 10);
const historyResult = await mcp('tools/call', { name: query.name, arguments: historyQuery }, 3);
const historyText = formatExpenseHistory(historyResult, historyQuery, { accountName: '日常支出', ledgerDisplayName: '日常账本' });
assert.match(historyText, /0\.01 SGD/); assert.doesNotMatch(historyText, /transactions|total_count|\{/);
console.log(JSON.stringify({ status: 'CLAWBOT_TEST_HTTP_DEDUPE_AND_MCP_HISTORY_OK', categories: 11, subcategories: 45, restartDedupe: true, readableHistory: true, historyLimit: 10 }));
