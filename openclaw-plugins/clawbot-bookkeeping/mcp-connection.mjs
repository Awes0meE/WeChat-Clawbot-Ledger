import { readFileSync } from 'node:fs';
import { assertDeploymentOrigin, PRODUCTION_DEPLOYMENT } from './deployment-profile.mjs';

function readMcpToken(path) {
  return readFileSync(path, 'utf8').trim();
}

export function createOwnerMcpConnectionResolver({
  config,
  serverBaseUrl,
  mcpTokenPath,
  readToken = readMcpToken,
  deployment = PRODUCTION_DEPLOYMENT,
}) {
  assertDeploymentOrigin(serverBaseUrl, deployment, 'MCP');
  const owners = new Set(Array.isArray(config?.commands?.ownerAllowFrom)
    ? config.commands.ownerAllowFrom
    : []);

  return async function resolveMcpConnection({ messageChannel, requesterSenderId } = {}) {
    if (messageChannel !== 'openclaw-weixin'
      || typeof requesterSenderId !== 'string'
      || requesterSenderId.trim() === '') {
      return null;
    }
    if (!owners.has(`${messageChannel}:${requesterSenderId}`)) return null;

    let token;
    try {
      token = readToken(mcpTokenPath).trim();
      if (!token) throw new Error('empty credential');
    } catch {
      throw new Error('MCP token is unavailable.');
    }
    return {
      url: `${deployment.origin}/mcp`,
      headers: { Authorization: `Bearer ${token}` },
    };
  };
}
