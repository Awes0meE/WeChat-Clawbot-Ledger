import { readFileSync, writeFileSync } from 'node:fs';
import { TEST_PATHS } from '/opt/clawbot/plugins/clawbot-bookkeeping/deployment-profile.mjs';

const path = '/opt/clawbot/plugins/clawbot-bookkeeping/openclaw.plugin.json';
const manifest = JSON.parse(readFileSync(path, 'utf8'));
if (manifest.configSchema.properties.serverBaseUrl.const !== 'http://127.0.0.1:8888'
  || manifest.mcpServers.ezbookkeeping.url !== 'http://127.0.0.1:8888/mcp') throw new Error('Unexpected source manifest');
manifest.configSchema.properties.deploymentProfile = { type: 'string', const: 'isolated-test' };
manifest.configSchema.properties.serverBaseUrl.const = 'http://127.0.0.1:18888';
for (const [key, value] of Object.entries(TEST_PATHS)) manifest.configSchema.properties[key] = { type: 'string', const: value };
manifest.configSchema.required = ['deploymentProfile', 'serverBaseUrl', ...Object.keys(TEST_PATHS)];
delete manifest.mcpServers;
manifest.contracts.tools.push('ezbookkeeping__query_transactions');
manifest.toolMetadata.ezbookkeeping__query_transactions = { profiles: ['full'] };
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
