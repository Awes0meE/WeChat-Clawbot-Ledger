import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('declares only the read-only ezBookkeeping MCP surface without credentials', () => {
  const manifestText = readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(manifestText);

  assert.deepEqual(Object.keys(manifest.mcpServers), ['ezbookkeeping']);
  assert.equal(manifest.mcpServers.ezbookkeeping.transport, 'streamable-http');
  assert.equal(manifest.mcpServers.ezbookkeeping.url, 'http://127.0.0.1:8180/mcp');
  assert.deepEqual(manifest.mcpServers.ezbookkeeping.toolFilter.include, ['query_transactions']);
  assert.equal(manifest.mcpServers.ezbookkeeping.toolFilter.include.includes('add_transaction'), false);
  assert.equal(manifestText.includes('Authorization'), false);
  assert.equal(manifestText.includes('Bearer '), false);
  assert.equal(manifestText.includes('mcp-token'), false);
  assert.equal(manifest.configSchema.properties.mcpTokenPath.type, 'string');
  assert.equal(manifest.configSchema.properties.mcpTokenPath.minLength > 0, true);
});
