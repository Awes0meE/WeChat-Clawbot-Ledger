import { readFileSync, writeFileSync } from 'node:fs';
const path = '/opt/clawbot/plugins/clawbot-bookkeeping/openclaw.plugin.json';
const manifest = JSON.parse(readFileSync(path, 'utf8'));
if (manifest.configSchema.properties.serverBaseUrl.const !== 'http://127.0.0.1:8888'
  || manifest.mcpServers.ezbookkeeping.url !== 'http://127.0.0.1:8888/mcp') throw new Error('Unexpected source manifest');
delete manifest.mcpServers;
manifest.contracts.tools.push('ezbookkeeping__query_transactions');
manifest.toolMetadata.ezbookkeeping__query_transactions = { profiles: ['full'] };
for (const [name, value] of Object.entries({ tokenPath: '/var/lib/clawbot/secrets/http-token',
  mcpTokenPath: '/var/lib/clawbot/secrets/mcp-token', stateDbPath: '/var/lib/clawbot/receipts/message-receipts.sqlite' })) {
  manifest.configSchema.properties[name] = { type: 'string', const: value };
}
manifest.configSchema.required = ['deploymentProfile', 'serverBaseUrl', 'tokenPath', 'mcpTokenPath', 'stateDbPath'];
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
