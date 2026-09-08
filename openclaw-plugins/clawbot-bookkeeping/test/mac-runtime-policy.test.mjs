import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBookkeeperRuntimePolicy, BOOKKEEPER_TOOLS } from '../../../deploy/docker/runtime-policy.mjs';
const configuration = () => ({
  agents: { entries: { bookkeeper: { model: { primary: 'openai/gpt-5.6-sol' },
    models: { 'openai/gpt-5.6-sol': { agentRuntime: { id: 'codex' } } }, thinkingDefault: 'low',
    tools: { profile: 'full', allow: [...BOOKKEEPER_TOOLS] }, bootstrapMaxChars: 8000, bootstrapTotalMaxChars: 16000 } } },
  plugins: { entries: { 'clawbot-bookkeeping': { hooks: { allowConversationAccess: true, allowPromptInjection: true } },
    codex: { config: { codexDynamicToolsLoading: 'direct' } } } },
});
test('requires message correlation grants and the exact six-tool policy', () => {
  assert.doesNotThrow(() => assertBookkeeperRuntimePolicy(configuration(), [4504, 1500]));
  for (const mutate of [
    (c) => { delete c.plugins.entries['clawbot-bookkeeping'].hooks.allowConversationAccess; },
    (c) => { c.agents.entries.bookkeeper.tools.allow.push('exec'); },
    (c) => { c.agents.entries.bookkeeper.tools.allow.pop(); },
    (c) => { c.agents.entries.bookkeeper.model.fallbacks = ['other']; },
    (c) => { c.agents.entries.bookkeeper.models['openai/gpt-5.6-sol'].agentRuntime.id = 'other'; },
  ]) { const config = configuration(); mutate(config); assert.throws(() => assertBookkeeperRuntimePolicy(config)); }
});
test('refuses truncation of individual rules or the combined bootstrap', () => {
  assert.throws(() => assertBookkeeperRuntimePolicy(configuration(), [8001]), /TRUNCATED/);
  assert.throws(() => assertBookkeeperRuntimePolicy(configuration(), [8000, 8000, 1]), /TRUNCATED/);
});
