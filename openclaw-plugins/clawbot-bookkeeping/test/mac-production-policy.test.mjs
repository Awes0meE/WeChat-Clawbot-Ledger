import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertProductionConfig } from '../../../deploy/docker/production-policy.mjs';

function fixture() {
  const agent = JSON.parse(readFileSync(new URL('../../../config/weixin-bookkeeper-agent.example.json', import.meta.url)))
    .find((entry) => entry.path === 'agents.entries.bookkeeper').value;
  Object.assign(agent, { workspace: '/opt/clawbot/workspace', bootstrapMaxChars: 8000, bootstrapTotalMaxChars: 16000 });
  return { agents: { entries: { bookkeeper: agent } }, commands: { ownerAllowFrom: ['openclaw-weixin:fixture-owner'] },
    bindings: [{ type: 'route', agentId: 'bookkeeper', match: { channel: 'openclaw-weixin', accountId: 'fixture-account' }, session: { dmScope: 'per-account-channel-peer' } }],
    gateway: { mode: 'local', bind: 'loopback', port: 18789, auth: { mode: 'token', token: 'synthetic-'.repeat(8) } },
    channels: { 'openclaw-weixin': { enabled: true } },
    plugins: { allow: ['clawbot-bookkeeping', 'openclaw-weixin', 'codex'],
      load: { paths: ['/opt/clawbot/plugins/clawbot-bookkeeping', '/opt/clawbot/plugins/openclaw-weixin-stable-id'] },
      entries: { 'clawbot-bookkeeping': { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true },
        config: { deploymentProfile: 'production', serverBaseUrl: 'http://127.0.0.1:8888', tokenPath: '/var/lib/clawbot/secrets/http-token',
          mcpTokenPath: '/var/lib/clawbot/secrets/mcp-token', stateDbPath: '/var/lib/clawbot/receipts/message-receipts.sqlite', accountName: '日常支出', ledgerDisplayName: '日常账本' } },
        'openclaw-weixin': { enabled: true }, codex: { enabled: true, config: { codexDynamicToolsLoading: 'direct' } } } },
    hooks: { internal: { enabled: true, entries: { 'session-memory': { enabled: true } } } } };
}
test('Production startup rejects test identities, extra tools/routes and non-loopback or mutable paths', () => {
  assert.doesNotThrow(() => assertProductionConfig(fixture(), [4504, 1000]));
  for (const change of [
    (c) => c.commands.ownerAllowFrom.push('openclaw-weixin:another'),
    (c) => c.commands.ownerAllowFrom[0] = 'openclaw-weixin:clawbot-test-owner',
    (c) => c.bindings.push(c.bindings[0]),
    (c) => c.agents.entries.bookkeeper.tools.allow.push('exec'),
    (c) => c.gateway.bind = 'lan',
    (c) => c.plugins.entries['clawbot-bookkeeping'].config.tokenPath = '/tmp/token',
    (c) => c.plugins.load.paths.push('/tmp/plugin'),
    (c) => c.plugins.entries['clawbot-bookkeeping'].config.deploymentProfile = 'isolated-test',
    (c) => c.plugins.entries['clawbot-bookkeeping'].hooks.allowConversationAccess = false,
  ]) { const config = fixture(); change(config); assert.throws(() => assertProductionConfig(config)); }
});
