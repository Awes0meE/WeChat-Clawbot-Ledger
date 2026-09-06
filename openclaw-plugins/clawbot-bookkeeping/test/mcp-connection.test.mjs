import assert from 'node:assert/strict';
import test from 'node:test';

import { createOwnerMcpConnectionResolver } from '../mcp-connection.mjs';

const ownerConfig = {
  commands: {
    ownerAllowFrom: ['openclaw-weixin:alice'],
  },
};

test('denies non-owner, wrong-channel, and missing requesters before reading the token', async () => {
  let reads = 0;
  const resolve = createOwnerMcpConnectionResolver({
    config: ownerConfig,
    serverBaseUrl: 'http://127.0.0.1:8888',
    mcpTokenPath: 'unused-token-path',
    readToken() {
      reads += 1;
      return 'mcp-token';
    },
  });

  assert.equal(await resolve({ messageChannel: 'openclaw-weixin', requesterSenderId: 'stranger' }), null);
  assert.equal(await resolve({ messageChannel: 'telegram', requesterSenderId: 'alice' }), null);
  assert.equal(await resolve({ messageChannel: 'openclaw-weixin', requesterSenderId: '' }), null);
  assert.equal(await resolve({ messageChannel: 'openclaw-weixin' }), null);
  assert.equal(reads, 0);
});

test('returns the SDK streamable-http connection shape only for the configured WeChat owner', async () => {
  let reads = 0;
  const resolve = createOwnerMcpConnectionResolver({
    config: ownerConfig,
    serverBaseUrl: 'http://127.0.0.1:8888',
    mcpTokenPath: 'unused-token-path',
    readToken() {
      reads += 1;
      return 'mcp-token';
    },
  });

  assert.deepEqual(await resolve({ messageChannel: 'openclaw-weixin', requesterSenderId: 'alice' }), {
    url: 'http://127.0.0.1:8888/mcp',
    headers: { Authorization: 'Bearer mcp-token' },
  });
  assert.equal(reads, 1);
});

test('fails safely when the configured owner MCP token is empty', async () => {
  const resolve = createOwnerMcpConnectionResolver({
    config: ownerConfig,
    serverBaseUrl: 'http://127.0.0.1:8888',
    mcpTokenPath: 'unused-token-path',
    readToken() { return '   '; },
  });

  await assert.rejects(
    () => resolve({ messageChannel: 'openclaw-weixin', requesterSenderId: 'alice' }),
    { message: 'MCP token is unavailable.' },
  );
});

test('does not expose token-file errors when the owner MCP credential cannot be read', async () => {
  const resolve = createOwnerMcpConnectionResolver({
    config: ownerConfig,
    serverBaseUrl: 'http://127.0.0.1:8888',
    mcpTokenPath: 'unused-token-path',
    readToken() { throw new Error('private fixture path and diagnostic'); },
  });
  await assert.rejects(
    () => resolve({ messageChannel: 'openclaw-weixin', requesterSenderId: 'alice' }),
    { message: 'MCP token is unavailable.' },
  );
});

test('rejects every server base URL except the exact local ezBookkeeping origin', () => {
  for (const serverBaseUrl of [
    'https://127.0.0.1:8888',
    'http://localhost:8888',
    'http://127.0.0.1:18888',
    'http://127.0.0.1:8888/',
    'http://user@127.0.0.1:8888',
    'http://127.0.0.1:8888?token=ignored',
    'http://127.0.0.1:8888#fragment',
  ]) {
    assert.throws(() => createOwnerMcpConnectionResolver({
      config: ownerConfig,
      serverBaseUrl,
      mcpTokenPath: 'unused-token-path',
    }), { message: 'MCP server base URL must be http://127.0.0.1:8888.' });
  }
});

test('does not infer an owner when the owner allow-list is absent', async () => {
  let reads = 0;
  const resolve = createOwnerMcpConnectionResolver({
    config: {},
    serverBaseUrl: 'http://127.0.0.1:8888',
    mcpTokenPath: 'unused-token-path',
    readToken() {
      reads += 1;
      return 'mcp-token';
    },
  });

  assert.equal(await resolve({ messageChannel: 'openclaw-weixin', requesterSenderId: 'alice' }), null);
  assert.equal(reads, 0);
});
