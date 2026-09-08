import { assertBookkeeperRuntimePolicy } from './runtime-policy.mjs';
export function assertProductionConfig(config, bootstrapLengths = []) {
  assertBookkeeperRuntimePolicy(config, bootstrapLengths);
  const fail = () => { throw new Error('CLAWBOT_PRODUCTION_CONFIG_INVALID'); };
  const plugin = config.plugins.entries['clawbot-bookkeeping'].config;
  const fixed = { deploymentProfile: 'production', serverBaseUrl: 'http://127.0.0.1:8888',
    tokenPath: '/var/lib/clawbot/secrets/http-token', mcpTokenPath: '/var/lib/clawbot/secrets/mcp-token',
    stateDbPath: '/var/lib/clawbot/receipts/message-receipts.sqlite', accountName: '日常支出', ledgerDisplayName: '日常账本' };
  for (const [key, value] of Object.entries(fixed)) if (plugin?.[key] !== value) fail();
  const owners = config.commands?.ownerAllowFrom;
  if (owners?.length !== 1 || typeof owners[0] !== 'string'
    || !/^openclaw-weixin:[^\s<>]+$/.test(owners[0]) || /clawbot-test/i.test(owners[0])) fail();
  const route = config.bindings?.[0];
  if (config.bindings?.length !== 1 || route?.type !== 'route' || route.agentId !== 'bookkeeper'
    || route.match?.channel !== 'openclaw-weixin' || !/^[^\s<>]+$/.test(route.match?.accountId ?? '')
    || /clawbot-test/i.test(route.match.accountId) || route.session?.dmScope !== 'per-account-channel-peer') fail();
  if (config.gateway?.mode !== 'local' || config.gateway.bind !== 'loopback' || config.gateway.port !== 18789
    || config.gateway.auth?.mode !== 'token' || typeof config.gateway.auth.token !== 'string'
    || config.gateway.auth.token.length < 32 || config.channels?.['openclaw-weixin']?.enabled !== true
    || Object.keys(config.channels).length !== 1 || Object.keys(config.agents.entries).join() !== 'bookkeeper'
    || config.agents.entries.bookkeeper.workspace !== '/opt/clawbot/workspace') fail();
  const paths = ['/opt/clawbot/plugins/clawbot-bookkeeping', '/opt/clawbot/plugins/openclaw-weixin-stable-id'];
  if (JSON.stringify(config.plugins.load?.paths) !== JSON.stringify(paths)
    || JSON.stringify([...config.plugins.allow].sort()) !== JSON.stringify(['clawbot-bookkeeping', 'codex', 'openclaw-weixin'])
    || Object.keys(config.plugins.entries).sort().join() !== 'clawbot-bookkeeping,codex,openclaw-weixin'
    || paths.some((_, i) => config.plugins.entries[['clawbot-bookkeeping', 'openclaw-weixin'][i]].enabled !== true)
    || config.plugins.entries.codex.enabled !== true || config.hooks?.internal?.enabled !== true
    || config.hooks.internal.entries?.['session-memory']?.enabled !== true) fail();
}
