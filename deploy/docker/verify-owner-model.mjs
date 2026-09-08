import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { resolveDeploymentProfile } from '/opt/clawbot/plugins/clawbot-bookkeeping/deployment-profile.mjs';
import { assertBookkeeperRuntimePolicy } from './runtime-policy.mjs';
import { agentCommand } from '/app/dist/agent-command-CDZzL1w0.js';
import { disposeRegisteredAgentHarnesses } from '/app/dist/plugin-sdk/agent-harness.js';
import { t as loadRegistry } from '/app/dist/runtime-plugins-CfPqEvbY.js';
import { k as setActiveRegistry } from '/app/dist/runtime-qPjwNjo-.js';

// Visibility probe only. Actual tool execution and source-bound reply acceptance
// use verify-channel-model.mjs with the full inbound/outbound channel pipeline.
const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH));
resolveDeploymentProfile(config.plugins.entries['clawbot-bookkeeping'].config, config);
assertBookkeeperRuntimePolicy(config);
const expected = config.agents.entries.bookkeeper.tools.allow;
const registry = loadRegistry({ config, basePluginIds: config.plugins.allow, workspaceDir: '/opt/clawbot/workspace' });
assert.ok(registry.channels.some((entry) => entry.plugin.id === 'openclaw-weixin'));
assert.equal(registry.mcpServerConnectionResolvers.length, 0);
assert.equal(createHash('sha256').update(readFileSync('/app/dist/codex-mcp-config-lF3PPwrW.js')).digest('hex'),
  'c2fc4d3e09c6eeb83319404e170e6453bd613d75580ab5074c53554a58b3fa0f');
setActiveRegistry(registry, 'clawbot-p1-owner-probe', 'default', '/opt/clawbot/workspace');
try {
  const result = await agentCommand({
    agentId: 'bookkeeper', sessionKey: `agent:bookkeeper:p1-visible-${randomUUID()}`,
    channel: 'openclaw-weixin', to: 'clawbot-test-owner',
    messageChannel: 'openclaw-weixin', messageProvider: 'openclaw-weixin',
    accountId: 'clawbot-test-account', senderIsOwner: true,
    runContext: { messageChannel: 'openclaw-weixin', accountId: 'clawbot-test-account', senderId: 'clawbot-test-owner', currentChannelId: 'clawbot-test-owner' },
    thinking: 'low', timeout: '120', deliver: false,
    oneShotCliRun: true, cleanupBundleMcpOnRunEnd: true, cleanupCliLiveSessionOnRunEnd: true,
    message: '这是独立连接测试，请勿调用工具，只回复 P1_SIX_TOOLS_OK。',
  }, { log() {}, error() {}, exit() { throw new Error('Model probe runtime exit'); } });
  const meta = result.meta ?? {}, agent = meta.agentMeta ?? {};
  const dynamic = meta.systemPromptReport?.tools?.entries?.map((t) => t.name) ?? [];
  assert.equal(agent.agentHarnessId, 'codex'); assert.equal(agent.model, 'gpt-5.6-sol');
  assert.deepEqual([...dynamic].sort(), [...expected].sort());
  assert.ok((result.payloads ?? []).some((p) => p.text?.includes('P1_SIX_TOOLS_OK')));
  console.log(JSON.stringify({ status: 'CLAWBOT_OWNER_MODEL_SIX_TOOLS_OK', harness: agent.agentHarnessId,
    model: agent.model, actualDynamicTools: dynamic, upstreamMcpModulePristine: true }));
} finally { await disposeRegisteredAgentHarnesses(); }
