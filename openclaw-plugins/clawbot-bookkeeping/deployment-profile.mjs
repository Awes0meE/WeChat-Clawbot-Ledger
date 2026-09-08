import { lstatSync, readFileSync, realpathSync } from 'node:fs';

const trusted = new WeakSet();
function profile(name, origin) {
  const value = Object.freeze({ name, origin });
  trusted.add(value);
  return value;
}

export const PRODUCTION_DEPLOYMENT = profile('production', 'http://127.0.0.1:8888');
export const TEST_PATHS = Object.freeze({
  tokenPath: '/var/lib/clawbot-test/secrets/http-token',
  mcpTokenPath: '/var/lib/clawbot-test/secrets/mcp-token',
  stateDbPath: '/var/lib/clawbot-test/receipts/message-receipts.sqlite',
});
export const TEST_OWNER = 'openclaw-weixin:clawbot-test-owner';
const markerPath = '/etc/clawbot-test/profile.json';

function readEvidence() {
  const stat = lstatSync(markerPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o222)
    || realpathSync(markerPath) !== markerPath) throw new Error('invalid marker');
  return JSON.parse(readFileSync(markerPath, 'utf8'));
}

// This is operator-side startup policy. Tool arguments never enter this function.
export function resolveDeploymentProfile(pluginConfig = {}, openclawConfig = {}, {
  environment = process.env,
  platform = process.platform,
  evidence = readEvidence,
} = {}) {
  const name = pluginConfig.deploymentProfile ?? 'production';
  if (name === 'production') {
    if (environment.CLAWBOT_DEPLOYMENT_PROFILE === 'isolated-test') {
      throw new Error('CLAWBOT_DEPLOYMENT_PROFILE_MISMATCH');
    }
    return PRODUCTION_DEPLOYMENT;
  }
  try {
    if (name !== 'isolated-test' || platform !== 'linux'
      || environment.CLAWBOT_DEPLOYMENT_PROFILE !== 'isolated-test'
      || environment.OPENCLAW_STATE_DIR !== '/var/lib/clawbot-test/openclaw'
      || pluginConfig.serverBaseUrl !== 'http://127.0.0.1:18888') throw new Error();
    for (const [key, value] of Object.entries(TEST_PATHS)) {
      if (pluginConfig[key] !== value) throw new Error();
    }
    const owners = openclawConfig.commands?.ownerAllowFrom;
    if (!Array.isArray(owners) || owners.length !== 1 || owners[0] !== TEST_OWNER
      || openclawConfig.channels?.['openclaw-weixin']?.enabled !== false
      || Object.keys(openclawConfig.channels?.['openclaw-weixin']?.accounts ?? {}).length) throw new Error();
    const marker = evidence();
    if (marker.profile !== 'isolated-test' || marker.project !== 'clawbot-test'
      || marker.ledgerServerId !== 1 || marker.owner !== TEST_OWNER
      || marker.origin !== pluginConfig.serverBaseUrl) throw new Error();
    return profile(name, marker.origin);
  } catch {
    throw new Error('CLAWBOT_ISOLATED_TEST_CONFIGURATION_INVALID');
  }
}

export function assertDeploymentOrigin(origin, deployment = PRODUCTION_DEPLOYMENT, kind = 'HTTP') {
  if (!trusted.has(deployment) || origin !== deployment.origin) {
    const expected = trusted.has(deployment) ? deployment.origin : PRODUCTION_DEPLOYMENT.origin;
    throw new Error(kind === 'MCP'
      ? `MCP server base URL must be ${expected}.`
      : `bookkeeping server must be the fixed loopback endpoint ${expected}`);
  }
}
