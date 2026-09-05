import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import plugin from '../index.ts';

function harness(fetchImpl, { token = true, directory } = {}) {
  const dir = directory ?? mkdtempSync(join(tmpdir(), 'clawbot-amount-tool-'));
  if (token) writeFileSync(join(dir, 'token.txt'), 'synthetic-token', 'utf8');
  const hooks = new Map();
  const tools = new Map();
  const logs = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  plugin.register({
    pluginConfig: {
      serverBaseUrl: 'http://127.0.0.1:8888', tokenPath: join(dir, 'token.txt'),
      stateDbPath: join(dir, 'state.sqlite'), accountName: '日常支出',
    },
    config: { commands: { ownerAllowFrom: ['openclaw-weixin:synthetic-owner'] } },
    logger: { error(message) { logs.push(message); } },
    on(name, handler) { hooks.set(name, handler); },
    registerTool(definition, options) { if (options?.name) tools.set(options.name, definition); },
    registerMcpServerConnectionResolver() {},
  });
  return {
    hooks, logs, directory: dir,
    tool(context = { senderIsOwner: true }) {
      const factory = tools.get('find_expenses');
      assert.equal(typeof factory, 'function', 'find_expenses must be registered');
      return factory(context);
    },
    close() {
      hooks.get('gateway_stop')?.({}, {});
      globalThis.fetch = originalFetch;
      if (!directory) rmSync(dir, { recursive: true, force: true });
    },
  };
}

const params = { amount: '3.36', currency: 'SGD' };
const row = {
  id: '101', timeSequenceId: '1788425460000', time: 1788425460,
  type: 3, categoryId: '201', category: { name: '数码装备' },
  sourceAccountId: '1', sourceAmount: 336, comment: '合成网线',
};
function fakeLedger(requests, result = { items: [row], nextTimeSequenceId: null }) {
  return async (url, options) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    let payload;
    if (parsed.pathname.endsWith('/accounts/list.json')) {
      payload = [{ id: '1', name: '日常支出', currency: 'SGD', hidden: false }];
    } else if (parsed.pathname.endsWith('/transaction/categories/list.json')) {
      payload = { 2: [{ id: '200', name: '学习进修', parentId: '0', subCategories: [
        { id: '201', name: '数码装备', parentId: '200' },
      ] }] };
    } else if (parsed.pathname.endsWith('/transactions/list.json')) {
      payload = typeof result === 'function' ? result(parsed) : result;
    } else assert.fail('Unexpected endpoint in read-only search');
    return Response.json({ success: true, result: payload });
  };
}

test('amount lookup has a direct tool, strict schema, manifest and dedicated agent allowlist', () => {
  const h = harness(async () => assert.fail('No network during registration'));
  try {
    const tool = h.tool();
    assert.equal(tool.catalogMode, 'direct-only');
    assert.equal(tool.parameters.anyOf.length, 2);
    for (const branch of tool.parameters.anyOf) {
      assert.equal(branch.additionalProperties, false);
      assert.ok(branch.required.includes('amount'));
      assert.ok(branch.required.includes('currency'));
      assert.equal(branch.properties.limit.maximum, 10);
    }
    const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
    assert.ok(manifest.contracts.tools.includes('find_expenses'));
    assert.deepEqual(manifest.toolMetadata.find_expenses, { profiles: ['minimal'] });
    const config = JSON.parse(readFileSync(new URL('../../../config/weixin-bookkeeper-agent.example.json', import.meta.url), 'utf8'));
    assert.ok(config.find(x => x.path === 'agents.entries.bookkeeper').value.tools.allow.includes('find_expenses'));
  } finally { h.close(); }
});

test('untrusted amount lookup fails before token access or HTTP', async () => {
  let requests = 0;
  const h = harness(async () => { requests++; assert.fail('Unauthorized HTTP'); }, { token: false });
  try {
    await assert.rejects(() => h.tool({ senderIsOwner: false }).execute('untrusted', params), /owner/i);
    assert.equal(requests, 0);
  } finally { h.close(); }
});

test('default amount lookup searches exact minor units across all history without MCP or writes', async () => {
  const requests = [];
  const h = harness(fakeLedger(requests));
  try {
    const result = await h.tool().execute('all-history', params);
    assert.equal(result.details.status, 'ok');
    assert.equal(result.details.amountMinor, 336);
    assert.equal(result.details.returnedCount, 1);
    assert.equal(result.details.hasMore, false);
    assert.match(result.content[0].text, /3\.36 SGD/u);
    assert.match(result.content[0].text, /全部历史/u);
    assert.match(result.content[0].text, /数码装备/u);
    assert.match(result.content[0].text, /合成网线/u);
    const query = requests.find(x => x.url.pathname.endsWith('/transactions/list.json')).url.searchParams;
    assert.equal(query.get('amount_filter'), 'eq:336');
    assert.equal(query.get('max_time'), '0');
    assert.equal(query.has('min_time'), false);
    assert.equal(query.get('count'), '4');
    assert.doesNotMatch(JSON.stringify(result.details), /合成网线|sourceAccountId|categoryId|timeSequenceId|comment/u);
  } finally { h.close(); }
});

test('amount lookup with explicit dates sends inclusive Singapore time bounds', async () => {
  const requests = [];
  const h = harness(fakeLedger(requests, { items: [], nextTimeSequenceId: null }));
  try {
    const result = await h.tool().execute('dated', { ...params, period: 'custom', startDate: '2026-09-01', endDate: '2026-09-04', limit: 10 });
    assert.equal(result.details.status, 'ok');
    const query = requests.at(-1).url.searchParams;
    assert.equal(query.get('min_time'), String(Date.parse('2026-09-01T00:00:00+08:00')));
    assert.equal(query.get('max_time'), String(Date.parse('2026-09-04T23:59:59.999+08:00')));
    assert.match(result.content[0].text, /没有单笔金额为 3\.36 SGD 的支出记录/u);
    assert.match(result.content[0].text, /2026\/09\/01/u);
  } finally { h.close(); }
});

test('invalid amount lookup parameters never reach HTTP', async () => {
  let requests = 0;
  const h = harness(async () => { requests++; assert.fail('Invalid query reached HTTP'); });
  try {
    for (const invalid of [{ ...params, amount: '3.361' }, { ...params, currency: 'USD' }, { ...params, limit: 11 }, { ...params, startDate: '2026-09-01' }]) {
      await assert.rejects(() => h.tool().execute('invalid', invalid));
    }
    assert.equal(requests, 0);
  } finally { h.close(); }
});

test('failed or malformed amount lookup cannot report no matching records or leak response data', async () => {
  for (const fetchImpl of [async () => { throw new Error('private-error-marker'); }, fakeLedger([], { items: null, secret: 'private-error-marker' })]) {
    const h = harness(fetchImpl);
    try {
      const result = await h.tool().execute('failure', params);
      assert.equal(result.details.status, 'failed');
      assert.doesNotMatch(result.content[0].text, /没有找到|没有支出记录/u);
      assert.doesNotMatch(JSON.stringify([result, h.logs]), /private-error-marker|synthetic-token/u);
    } finally { h.close(); }
  }
});

async function bindOwner(h, runId, toolCallId, query = params) {
  const context = { channelId: 'openclaw-weixin', accountId: 'synthetic-bot', senderId: 'synthetic-owner', messageId: runId, sessionKey: 'synthetic-session', runId };
  await h.hooks.get('message_received')({ content: '帮我查有没有3.36的账', timestamp: Date.now() / 1000, ...context }, context);
  await h.hooks.get('before_agent_run')({ prompt: '帮我查有没有3.36的账', messages: [], senderIsOwner: true }, { ...context, trigger: 'user' });
  await h.hooks.get('before_tool_call')({ toolName: 'find_expenses', params: query, runId, toolCallId }, { runId, toolCallId, sessionKey: context.sessionKey });
  return context;
}

test('a compacted trusted query works and the final reply preserves the authoritative search result', async () => {
  const h = harness(fakeLedger([]));
  try {
    const context = await bindOwner(h, 'trusted-search-run', 'trusted-search-call');
    const result = await h.tool({ senderIsOwner: false }).execute('trusted-search-call', params);
    assert.equal(result.details.status, 'ok');
    await h.hooks.get('after_tool_call')({ toolName: 'find_expenses', result, runId: context.runId }, context);
    const outgoing = await h.hooks.get('reply_payload_sending')({ kind: 'final', payload: { text: 'invented-answer' }, runId: context.runId }, context);
    assert.equal(outgoing.payload.text, result.content[0].text);
    const wechat = await h.hooks.get('message_sending')({ to: context.senderId, content: 'invented-answer', metadata: { channel: context.channelId, accountId: context.accountId, runId: context.runId } }, context);
    assert.equal(wechat.content, result.content[0].text);
  } finally { h.close(); }
});

test('successive amount queries read fresh results instead of replaying the previous answer', async () => {
  const requests = [];
  const h = harness(fakeLedger(requests, (url) => url.searchParams.get('amount_filter') === 'eq:336'
    ? { items: [row], nextTimeSequenceId: null }
    : { items: [], nextTimeSequenceId: null }));
  try {
    const first = await h.tool().execute('search-first', params);
    const second = await h.tool().execute('search-second', { ...params, amount: '4.25' });
    assert.equal(first.details.returnedCount, 1);
    assert.equal(second.details.returnedCount, 0);
    assert.match(second.content[0].text, /4\.25 SGD/u);
    assert.doesNotMatch(second.content[0].text, /3\.36/u);
    assert.equal(requests.filter(x => x.url.pathname.endsWith('/transactions/list.json')).length, 2);
  } finally { h.close(); }
});

test('independent execution persists the current amount result for a separate WeChat sender instance', async () => {
  const requests = [];
  const hookHost = harness(fakeLedger(requests));
  const executionHost = harness(fakeLedger(requests), { directory: hookHost.directory });
  const senderHost = harness(fakeLedger(requests), { directory: hookHost.directory });
  try {
    const context = await bindOwner(hookHost, 'cross-search-run', 'cross-hook-call');
    const toolContext = {
      senderIsOwner: true, messageChannel: context.channelId, requesterSenderId: context.senderId,
      agentAccountId: context.accountId, sessionKey: context.sessionKey,
    };
    const result = await executionHost.tool(toolContext).execute('cross-execution-call', params);
    const outgoing = await senderHost.hooks.get('message_sending')({
      to: context.senderId, content: 'invented-answer',
      metadata: { channel: context.channelId, accountId: context.accountId, runId: 'independent-sender' },
    }, { channelId: context.channelId, accountId: context.accountId, runId: 'independent-sender' });
    assert.equal(outgoing?.content, result.content[0].text, 'current search result must cross plugin instances');
    await senderHost.hooks.get('message_sent')({ to: context.senderId, success: true, runId: 'independent-sender' },
      { channelId: context.channelId, accountId: context.accountId, runId: 'independent-sender' });
    await bindOwner(hookHost, 'cross-second-run', 'cross-second-hook-call', { ...params, amount: '4.25' });
    // A fresh message must win over the previous tool result in this execution instance.
    const second = await executionHost.tool(toolContext).execute('cross-second-execution-call', { ...params, amount: '4.25' });
    assert.equal(second.details.status, 'failed'); // fake server returned 3.36, so it must fail closed.
    const failedOutgoing = await senderHost.hooks.get('message_sending')({
      to: context.senderId, content: 'invented-no-matches',
      metadata: { channel: context.channelId, accountId: context.accountId, runId: 'independent-second-sender' },
    }, { channelId: context.channelId, accountId: context.accountId, runId: 'independent-second-sender' });
    assert.equal(failedOutgoing?.content, second.content[0].text);
    assert.doesNotMatch(failedOutgoing.content, /3\.36|没有单笔金额/u);
    const readsBefore = requests.length;
    await assert.rejects(() => executionHost.tool(toolContext).execute('unbound-repeated-search', params));
    assert.equal(requests.length, readsBefore);
  } finally { senderHost.close(); executionHost.close(); hookHost.close(); }
});
