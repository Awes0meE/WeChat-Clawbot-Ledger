import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('defines final-only routing for bookkeeping reads and writes', () => {
  const prompt = readFileSync(new URL('../../../openclaw-workspace/AGENTS.md', import.meta.url), 'utf8');

  assert.equal(prompt.includes('查询/统计意图优先'), true);
  assert.equal(prompt.includes('summarize_expenses'), true);
  assert.equal(prompt.includes('query_transactions'), true);
  assert.equal(prompt.includes('不得重新计算'), true);
  assert.match(prompt, /不展示思考过程、工具名、JSON、参数/u);
  assert.equal(prompt.includes('账本暂时连不上，本次没有读取任何数据，请稍后再试。'), true);
  assert.equal(prompt.includes('只处理当前用户从微信发来的个人记账请求'), false);
});

test('keeps the bookkeeper restricted to its three final-only tools', () => {
  const config = JSON.parse(readFileSync(new URL('../../../config/weixin-bookkeeper-agent.example.json', import.meta.url), 'utf8'));
  const bookkeeper = config.find((entry) => entry.path === 'agents.entries.bookkeeper').value;

  assert.deepEqual(bookkeeper.tools.allow, [
    'record_expense',
    'summarize_expenses',
    'ezbookkeeping__query_transactions',
  ]);
  assert.equal(bookkeeper.tools.profile, 'minimal');
  assert.equal(bookkeeper.thinkingDefault, 'off');
  assert.equal(bookkeeper.reasoningDefault, 'off');
  assert.equal(bookkeeper.tools.loopDetection.enabled, true);
  assert.equal(bookkeeper.contextInjection, 'continuation-skip');
});
