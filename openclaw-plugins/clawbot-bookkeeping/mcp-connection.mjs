import { readFileSync } from 'node:fs';

const EZBOOKKEEPING_ORIGIN = 'http://127.0.0.1:8888';
const EZBOOKKEEPING_MCP_URL = `${EZBOOKKEEPING_ORIGIN}/mcp`;

function readMcpToken(path) {
  return readFileSync(path, 'utf8').trim();
}

function assertExactEzBookkeepingOrigin(serverBaseUrl) {
  if (typeof serverBaseUrl !== 'string' || serverBaseUrl !== EZBOOKKEEPING_ORIGIN) {
    throw new Error('MCP server base URL must be http://127.0.0.1:8888.');
  }
  const url = new URL(serverBaseUrl);
  if (url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.port !== '8888'
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== '/') {
    throw new Error('MCP server base URL must be http://127.0.0.1:8888.');
  }
}

export function createOwnerMcpConnectionResolver({
  config,
  serverBaseUrl,
  mcpTokenPath,
  readToken = readMcpToken,
}) {
  assertExactEzBookkeepingOrigin(serverBaseUrl);
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

    const token = readToken(mcpTokenPath).trim();
    if (!token) throw new Error('MCP token is unavailable.');
    return {
      url: EZBOOKKEEPING_MCP_URL,
      headers: { Authorization: `Bearer ${token}` },
    };
  };
}
