import { readFileSync, writeFileSync, mkdirSync, existsSync, chownSync, chmodSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolveDeploymentProfile, TEST_PATHS, TEST_OWNER } from '/opt/clawbot/plugins/clawbot-bookkeeping/deployment-profile.mjs';

const root = '/var/lib/clawbot-test';
const marker = `${root}/config/initialized.json`;
const mode = process.argv[2] ?? 'initialize';
if (!['initialize', 'tokens', 'token-status', 'refresh-agent-limits'].includes(mode)) throw new Error('Unknown initialization mode');
if (mode === 'refresh-agent-limits' && !existsSync(marker)) throw new Error('Test volumes are not initialized');
if (mode === 'token-status') {
  const present = [TEST_PATHS.tokenPath, TEST_PATHS.mcpTokenPath].map(existsSync);
  console.log(present.every(Boolean) ? 'READY' : present.some(Boolean) ? 'INCOMPLETE' : 'EMPTY');
} else if (mode === 'tokens') {
  if (!existsSync(marker) || JSON.parse(readFileSync(marker)).project !== 'clawbot-test') throw new Error('Test volumes are not initialized');
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const value = JSON.parse(input);
  for (const [type, path] of [['api', TEST_PATHS.tokenPath], ['mcp', TEST_PATHS.mcpTokenPath]]) {
    if (typeof value[type] !== 'string' || !value[type].trim() || /[\r\n]/.test(value[type])) throw new Error('Invalid test token input');
    if (existsSync(path)) throw new Error('Refusing to replace existing test credentials');
  }
  // Validate both inputs and destinations before writing either credential.
  // A disk failure can still leave a partial pair; token-status then fails
  // closed and bootstrap must not generate additional sessions automatically.
  for (const [type, path] of [['api', TEST_PATHS.tokenPath], ['mcp', TEST_PATHS.mcpTokenPath]]) {
    writeFileSync(path, value[type], { mode: 0o600, flag: 'wx' }); chownSync(path, 1000, 1000);
  }
  console.log('CLAWBOT_TEST_TOKENS_READY');
} else if (existsSync(marker)) {
  const saved = JSON.parse(readFileSync(marker));
  if (saved.project !== 'clawbot-test' || saved.version !== 1) throw new Error('Unknown existing volume');
  const config = JSON.parse(readFileSync(`${root}/openclaw/openclaw.json`));
  resolveDeploymentProfile(config.plugins.entries['clawbot-bookkeeping'].config, config);
  if (mode === 'refresh-agent-limits') {
    config.agents.entries.bookkeeper.bootstrapMaxChars = 8000;
    config.agents.entries.bookkeeper.bootstrapTotalMaxChars = 16000;
    config.plugins.entries['clawbot-bookkeeping'].hooks = { allowConversationAccess: true, allowPromptInjection: true };
    writeFileSync(`${root}/openclaw/openclaw.json`, JSON.stringify(config, null, 2), { mode: 0o600 });
    chownSync(`${root}/openclaw/openclaw.json`, 1000, 1000);
    console.log('CLAWBOT_TEST_AGENT_LIMITS_REFRESHED');
  }
  console.log('CLAWBOT_TEST_VOLUMES_ALREADY_INITIALIZED');
} else {
  for (const name of ['config', 'ledger', 'bootstrap', 'secrets', 'receipts', 'openclaw', 'codex']) {
    const path = `${root}/${name}`;
    if (existsSync(path) && readdirSync(path).length) throw new Error('Refusing nonempty unrecognized test volume');
    mkdirSync(path, { recursive: true }); chownSync(path, 1000, 1000); chmodSync(path, 0o700);
  }
  for (const name of ['data', 'log', 'storage']) {
    mkdirSync(`${root}/ledger/${name}`); chownSync(`${root}/ledger/${name}`, 1000, 1000);
  }
  const ini = readFileSync('/opt/clawbot/docker/ezbookkeeping.test.ini', 'utf8').replace('__GENERATE_LOCAL_TEST_SECRET__', randomBytes(32).toString('hex'));
  writeFileSync(`${root}/config/ezbookkeeping.ini`, ini, { mode: 0o400 }); chownSync(`${root}/config/ezbookkeeping.ini`, 1000, 1000);
  writeFileSync(`${root}/bootstrap/password`, randomBytes(32).toString('hex'), { mode: 0o400 }); chownSync(`${root}/bootstrap/password`, 1000, 1000);
  const agentTemplate = JSON.parse(readFileSync('/opt/clawbot/config/weixin-bookkeeper-agent.example.json')).find((x) => x.path === 'agents.entries.bookkeeper').value;
  agentTemplate.workspace = '/opt/clawbot/workspace';
  agentTemplate.bootstrapMaxChars = 8000;
  agentTemplate.bootstrapTotalMaxChars = 16000;
  const pluginConfig = { deploymentProfile: 'isolated-test', serverBaseUrl: 'http://127.0.0.1:18888', ...TEST_PATHS, accountName: '日常支出', ledgerDisplayName: '日常账本' };
  const config = {
    gateway: { mode: 'local', bind: 'loopback', port: 18789, auth: { mode: 'token', token: randomBytes(32).toString('hex') } },
    agents: { entries: { bookkeeper: agentTemplate } },
    commands: { ownerAllowFrom: [TEST_OWNER] },
    channels: { 'openclaw-weixin': { enabled: false } },
    plugins: {
      allow: ['clawbot-bookkeeping', 'openclaw-weixin', 'codex'],
      load: { paths: ['/opt/clawbot/plugins/clawbot-bookkeeping', '/opt/clawbot/plugins/openclaw-weixin-stable-id'] },
      entries: {
        'clawbot-bookkeeping': { enabled: true, config: pluginConfig,
          hooks: { allowConversationAccess: true, allowPromptInjection: true } },
        'openclaw-weixin': { enabled: true },
        codex: { enabled: true, config: { codexDynamicToolsLoading: 'direct' } },
      },
    },
    hooks: { internal: { enabled: true, entries: { 'session-memory': { enabled: true } } } },
  };
  resolveDeploymentProfile(pluginConfig, config);
  writeFileSync(`${root}/openclaw/openclaw.json`, JSON.stringify(config, null, 2), { mode: 0o600 }); chownSync(`${root}/openclaw/openclaw.json`, 1000, 1000);
  writeFileSync(marker, JSON.stringify({ project: 'clawbot-test', version: 1 }), { mode: 0o400 }); chownSync(marker, 1000, 1000);
  console.log('CLAWBOT_TEST_VOLUMES_INITIALIZED');
}
