import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import plugin from '../index.ts';

const toolName = 'ezbookkeeping__query_transactions';
const query = { start_time: '1970-01-01T00:00:00Z', end_time: '2026-09-07T14:00:24+08:00', count: 3 };
const context = {
  runId: 'history-run', toolCallId: 'history-call', sessionKey: 'owner-session',
  channelId: 'openclaw-weixin', accountId: 'test-bot', senderId: 'test-owner', messageId: 'history-message',
  requester: { channel: 'openclaw-weixin', accountId: 'test-bot', senderId: 'test-owner', senderIsOwner: true },
};
const rows = [3, 2, 1].map((n) => ({ time: `2026-09-07T13:0${n}:00+08:00`, type: 'expense', amount: `${n}.10`, currency: 'SGD', category_name: '餐饮', account_name: '日常支出', comment: `合成测试${n}` }));
const result = { content: [{ type: 'text', text: JSON.stringify({ total_count: 3, current_page: 1, total_page: 1, transactions: rows }) }] };
function harness(directory) {
  const hooks = new Map();
  plugin.register({ pluginConfig: { stateDbPath: join(directory, 'state.sqlite'), accountName: '日常支出' }, on: (name, callback) => hooks.set(name, callback), registerTool() {}, registerMcpServerConnectionResolver() {}, logger: { error() {}, info() {} } });
  return hooks;
}
async function inbound(hooks, ctx = context) {
  await hooks.get('message_received')({ content: '最近三次支出', timestamp: 1788760824 }, ctx);
  await hooks.get('before_agent_run')({ prompt: '最近三次支出', senderIsOwner: true }, ctx);
}
for (const separateInstances of [false, true]) test(`history response stays readable across hook and send instances: ${separateInstances}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'history-hooks-'));
  const instances = [harness(directory)];
  try {
    await inbound(instances[0]);
    if (separateInstances) instances.push(harness(directory));
    const before = instances.at(-1);
    const modified = await before.get('before_tool_call')({ toolName, params: query }, context);
    assert.equal(modified?.params?.account_name, '日常支出');
    assert.equal(modified.params.type, 'expense');
    if (separateInstances) instances.push(harness(directory));
    const after = instances.at(-1);
    await after.get('after_tool_call')({ toolName, params: modified.params, result }, { runId: context.runId, toolCallId: context.toolCallId });
    const final = await after.get('reply_payload_sending')({ kind: 'final', payload: { text: result.content[0].text } }, context);
    assert.match(final?.payload?.text ?? '', /支出明细/u);
    assert.match(final.payload.text, /3\.10 SGD/u);
    assert.doesNotMatch(final.payload.text, /transactions|total_count|account_name/u);
    if (separateInstances) instances.push(harness(directory));
    const sent = await instances.at(-1).get('message_sending')({ to: 'test-owner', content: result.content[0].text }, { channelId: 'openclaw-weixin', runId: 'outer-run' });
    assert.equal(sent?.content, final.payload.text);
  } finally { for (const hooks of instances) hooks.get('gateway_stop')({}, {}); rmSync(directory, { recursive: true, force: true }); }
});

for (const badResult of [{ isError: true, content: [{ type: 'text', text: 'private transport error' }] }, { content: [{ type: 'text', text: '{invalid raw JSON' }] }, undefined]) test(`history malformed result never reaches final reply: ${JSON.stringify(badResult)}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'history-hooks-'));
  const hooks = harness(directory);
  try {
    await inbound(hooks);
    const adjusted = await hooks.get('before_tool_call')({ toolName, params: query }, context);
    await hooks.get('after_tool_call')({ toolName, params: adjusted?.params, result: badResult, ...(badResult ? {} : { error: 'private transport error' }) }, context);
    const final = await hooks.get('reply_payload_sending')({ kind: 'final', payload: { text: 'private transport error' } }, context);
    assert.match(final?.payload?.text ?? '', /没有取得可靠的支出明细/u);
    assert.doesNotMatch(final.payload.text, /private|JSON/u);
  } finally { hooks.get('gateway_stop')({}, {}); rmSync(directory, { recursive: true, force: true }); }
});

test('history refuses an untrusted caller or an out-of-scope account', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'history-hooks-'));
  const hooks = harness(directory);
  try {
    assert.equal((await hooks.get('before_tool_call')({ toolName, params: query }, { ...context, requester: { ...context.requester, senderIsOwner: false } }))?.block, true);
    await inbound(hooks);
    assert.equal((await hooks.get('before_tool_call')({ toolName, params: { ...query, account_name: 'another-account' } }, { ...context, toolCallId: 'other-call' }))?.block, true);
  } finally { hooks.get('gateway_stop')({}, {}); rmSync(directory, { recursive: true, force: true }); }
});
