import assert from 'node:assert/strict';
import test from 'node:test';
import { createRestrictedHistoryTool, createPinnedMcpFetch } from '../restricted-history.mjs';

const context = { senderIsOwner: true, messageChannel: 'openclaw-weixin', requesterSenderId: 'alice' };
const config = { commands: { ownerAllowFrom: ['openclaw-weixin:alice'] } };
const pluginConfig = { serverBaseUrl: 'http://127.0.0.1:8888', mcpTokenPath: 'unused', accountName: '日常支出', ledgerDisplayName: '日常账本' };
const query = { start_time: '2026-09-01T00:00:00Z', end_time: '2026-09-09T00:00:00Z' };
const payload = { total_count: 1, total_page: 1, current_page: 1, secret: 'must-drop', transactions: [
  { time: '2026-09-07T00:00:00Z', amount: '1.23', type: 'expense', currency: 'SGD', account_name: '日常支出', category_name: '餐饮', transaction_id: 'must-drop' },
] };
function setup(overrides = {}) {
  const calls = { secrets: 0, connections: 0, queries: [], closed: 0 };
  const tool = createRestrictedHistoryTool({ config, pluginConfig, context,
    readToken: () => { calls.secrets++; return 'synthetic-test-token'; },
    clientFactory: async (connection) => {
      calls.connections++;
      assert.equal(connection.url, 'http://127.0.0.1:8888/mcp');
      return { query: async (args) => { calls.queries.push(args); return { structuredContent: payload }; },
        close: async () => { calls.closed++; } };
    }, ...overrides });
  return { tool, calls };
}
for (const identity of [{ senderIsOwner: false }, { requesterSenderId: 'stranger' }, { messageChannel: 'telegram' }, { requesterSenderId: undefined }]) {
  test(`rejects caller before reading credentials: ${JSON.stringify(identity)}`, () => {
    const { tool, calls } = setup({ context: { ...context, ...identity } });
    assert.equal(tool, null); assert.equal(calls.secrets, 0); assert.equal(calls.connections, 0);
  });
}
test('pins the query, strips non-business fields and closes the MCP session', async () => {
  const { tool, calls } = setup();
  const result = await tool.execute('test', { ...query, count: 200, response_fields: 'transaction_id' });
  assert.notEqual(result.isError, true); assert.match(result.content[0].text, /1\.23 SGD/);
  assert.doesNotMatch(JSON.stringify(result), /must-drop|transaction_id|synthetic-test-token/);
  assert.equal(calls.queries[0].count, 10); assert.equal(calls.queries[0].account_name, '日常支出');
  assert.equal(calls.queries[0].type, 'expense');
  assert.equal(calls.queries[0].response_fields, 'time,currency,category_name,account_name,comment');
  assert.equal(calls.closed, 1);
});
for (const params of [{ account_name: 'other' }, { type: 'income' }, { url: 'http://example.com' }, { keyword: {} }, { start_time: 'bad' }, { page: -1 }]) {
  test(`rejects invalid query before connecting: ${JSON.stringify(params)}`, async () => {
    const { tool, calls } = setup();
    assert.equal((await tool.execute('test', { ...query, ...params })).isError, true);
    assert.equal(calls.connections, 0); assert.equal(calls.secrets, 0);
  });
}
test('cancellation before invocation does not read the credential', async () => {
  const { tool, calls } = setup();
  assert.equal((await tool.execute('test', query, AbortSignal.abort())).isError, true);
  assert.equal(calls.secrets, 0);
});
test('server errors do not disclose credentials and still close the client', async () => {
  let closed = false;
  const { tool } = setup({ clientFactory: async () => ({ query: async () => { throw new Error('secret-value'); }, close: async () => { closed = true; } }) });
  const result = await tool.execute('test', query);
  assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result), /secret-value/); assert.equal(closed, true);
});
test('a cross-account backend response is rejected', async () => {
  const { tool } = setup({ clientFactory: async () => ({ query: async () => ({ structuredContent: { ...payload,
    transactions: [{ ...payload.transactions[0], account_name: 'other' }] } }), close: async () => {} }) });
  assert.equal((await tool.execute('test', query)).isError, true);
});
test('transport rejects redirects, endpoint changes and oversized bodies', async () => {
  const url = 'http://127.0.0.1:18888/mcp';
  let count = 0;
  const fetcher = createPinnedMcpFetch(url, AbortSignal.timeout(1000), async (_input, init) => {
    count++; assert.equal(init.redirect, 'error'); return new Response('x'.repeat(128_001));
  });
  await assert.rejects(fetcher('http://127.0.0.1:18888/other'));
  assert.equal(count, 0);
  await assert.rejects((await fetcher(url)).text(), /exceeds limit/);
});
