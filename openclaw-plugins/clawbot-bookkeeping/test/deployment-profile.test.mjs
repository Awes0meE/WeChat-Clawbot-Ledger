import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDeploymentProfile, PRODUCTION_DEPLOYMENT, TEST_OWNER, TEST_PATHS } from '../deployment-profile.mjs';
import { EzBookkeepingApi } from '../adapter.mjs';
import { createOwnerMcpConnectionResolver } from '../mcp-connection.mjs';

const configuration = () => ({ deploymentProfile: 'isolated-test', serverBaseUrl: 'http://127.0.0.1:18888', ...TEST_PATHS });
const globalConfig = () => ({ commands: { ownerAllowFrom: [TEST_OWNER] }, channels: { 'openclaw-weixin': { enabled: false } } });
const options = () => ({ platform: 'linux', environment: { CLAWBOT_DEPLOYMENT_PROFILE: 'isolated-test', OPENCLAW_STATE_DIR: '/var/lib/clawbot-test/openclaw' }, evidence: () => ({ profile: 'isolated-test', project: 'clawbot-test', ledgerServerId: 1, owner: TEST_OWNER, origin: 'http://127.0.0.1:18888' }) });

test('production stays the default and rejects a test environment mismatch', () => {
  assert.equal(resolveDeploymentProfile({}, {}, { environment: {} }), PRODUCTION_DEPLOYMENT);
  assert.throws(() => resolveDeploymentProfile({}, {}, options()), /MISMATCH/);
  assert.throws(() => new EzBookkeepingApi({ serverBaseUrl: 'http://127.0.0.1:18888' }), /loopback/);
  assert.throws(() => new EzBookkeepingApi({ serverBaseUrl: 'http://127.0.0.1:18888', deployment: { origin: 'http://127.0.0.1:18888' } }), /loopback/);
});

for (const [name, mutate] of [
  ['production origin', (c) => { c.serverBaseUrl = 'http://127.0.0.1:8888'; }],
  ['production token path', (c) => { c.tokenPath = '/production/token'; }],
  ['shared MCP token', (c) => { c.mcpTokenPath = c.tokenPath; }],
  ['production state', (c) => { c.stateDbPath = '/production/receipts.sqlite'; }],
  ['unexpected owner', (_, g) => { g.commands.ownerAllowFrom = ['openclaw-weixin:other']; }],
  ['enabled receiver', (_, g) => { g.channels['openclaw-weixin'].enabled = true; }],
  ['logged in account config', (_, g) => { g.channels['openclaw-weixin'].accounts = { fixture: {} }; }],
  ['missing env', (_, __, o) => { o.environment = {}; }],
  ['non Linux', (_, __, o) => { o.platform = 'darwin'; }],
  ['bad marker', (_, __, o) => { o.evidence = () => ({ profile: 'isolated-test' }); }],
  ['missing marker', (_, __, o) => { o.evidence = () => { throw new Error('private path'); }; }],
]) {
  test(`test profile fails closed on ${name}`, () => {
    const c = configuration(), g = globalConfig(), o = options(); mutate(c, g, o);
    assert.throws(() => resolveDeploymentProfile(c, g, o), { message: 'CLAWBOT_ISOLATED_TEST_CONFIGURATION_INVALID' });
  });
}

test('authorized test profile confines HTTP and MCP to 18888 and denies other senders', async () => {
  const deployment = resolveDeploymentProfile(configuration(), globalConfig(), options());
  const api = new EzBookkeepingApi({ serverBaseUrl: deployment.origin, deployment });
  assert.equal(api.baseUrl, 'http://127.0.0.1:18888');
  for (const serverBaseUrl of ['http://127.0.0.1:8888', 'http://127.0.0.1:18888/', 'http://localhost:18888', 'http://127.0.0.1:18888?x=1']) {
    assert.throws(() => new EzBookkeepingApi({ serverBaseUrl, deployment }), /loopback/);
  }
  let reads = 0;
  const resolver = createOwnerMcpConnectionResolver({ config: globalConfig(), serverBaseUrl: deployment.origin, deployment, readToken: () => { reads++; return 'synthetic'; } });
  assert.equal(await resolver({ messageChannel: 'openclaw-weixin', requesterSenderId: 'other' }), null);
  assert.equal(reads, 0);
  assert.deepEqual(await resolver({ messageChannel: 'openclaw-weixin', requesterSenderId: 'clawbot-test-owner' }), { url: 'http://127.0.0.1:18888/mcp', headers: { Authorization: 'Bearer synthetic' } });
});
