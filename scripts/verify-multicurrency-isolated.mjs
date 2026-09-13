// Opt-in API acceptance. Owns one temporary container and tmpfs, with no production mounts.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { prepareMulticurrencyAccounts, runMulticurrencyAccountPreparation } from './prepare-multicurrency-accounts.mjs';
import { CURRENCY_CODES } from '../openclaw-plugins/clawbot-bookkeeping/currency.mjs';
import { EzBookkeepingApi, SqliteReceiptStore } from '../openclaw-plugins/clawbot-bookkeeping/adapter.mjs';
import { resolveDeploymentProfile, TEST_PATHS, TEST_OWNER } from '../openclaw-plugins/clawbot-bookkeeping/deployment-profile.mjs';
import { recordExpense } from '../openclaw-plugins/clawbot-bookkeeping/bookkeeping-core.mjs';
import { answerBookkeepingQuestions } from '../openclaw-plugins/clawbot-bookkeeping/bookkeeping-queries.mjs';

if (process.argv[2] !== '--run' || process.argv.length !== 3) throw new Error('Use --run for the isolated Docker acceptance');
await new Promise((resolve, reject) => {
  const server = createServer(); server.once('error', reject); server.listen(18888, '127.0.0.1', () => server.close(resolve));
});
const directory = mkdtempSync(join(tmpdir(), 'clawbot-fx-acceptance-'));
const containerName = `clawbot-fx-acceptance-${randomBytes(6).toString('hex')}`;
const label = `clawbot.acceptance=${containerName}`;
const origin = 'http://127.0.0.1:18888';
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let containerId;
let token;
const request = async (path, payload) => {
  const r = await fetch(origin + path, { method: payload ? 'POST' : 'GET', signal: AbortSignal.timeout(10000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', 'X-Timezone-Name': 'Asia/Singapore' },
    ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const data = await r.json();
  if (!r.ok || data.success !== true) throw new Error(`Isolated request failed: ${path} HTTP ${r.status}; code ${data.errorCode ?? 'unknown'}: ${data.errorMessage ?? 'unknown'}`);
  return data.result;
};
try {
  const config = readFileSync(new URL('../deploy/docker/ezbookkeeping.test.ini', import.meta.url), 'utf8')
    .replace('http_addr = 127.0.0.1', 'http_addr = 0.0.0.0')
    .replaceAll('/var/lib/clawbot-test/ledger', '/acceptance')
    .replace('__GENERATE_LOCAL_TEST_SECRET__', randomBytes(32).toString('hex'))
    .replace('enable_register = false', 'enable_register = true')
    .replace('enable_mcp = true', 'enable_mcp = false')
    .replace('mode = file', 'mode = console');
  writeFileSync(join(directory, 'acceptance.ini'), config, { mode: 0o644 });
  containerId = docker(['run', '-d', '--name', containerName, '--label', label,
    '--publish', '127.0.0.1:18888:18888', '--tmpfs', '/acceptance:rw,nosuid,nodev,mode=1777',
    '--mount', `type=bind,src=${join(directory, 'acceptance.ini')},dst=/acceptance.ini,readonly`,
    '--entrypoint', '/bin/sh',
    'mayswind/ezbookkeeping@sha256:1043c95201f0432cd30328f6feb9a5b57359449400ea54fdf9a0c6138ab4c227',
    '-c', 'mkdir -p /acceptance/data /acceptance/log /acceptance/storage && exec /ezbookkeeping/ezbookkeeping --conf-path /acceptance.ini --no-boot-log server run']);
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(origin + '/healthz.json', { signal: AbortSignal.timeout(1000) }); if (r.ok) { ready = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) { const logs = spawnSync('docker', ['logs', containerId], {encoding:'utf8'}); console.error((logs.stdout + logs.stderr).replace(/[a-f0-9]{32,}/gu, '[redacted]').slice(-3000)); console.error(docker(['inspect', '--format', '{{json .State}}', containerId])); }
  assert.equal(ready, true, 'Isolated origin did not start');
  const registered = await request('/api/register.json', { username: 'currencytest', email: 'currencytest@example.invalid', nickname: 'Synthetic acceptance', password: randomBytes(32).toString('hex'), language: 'zh_Hans', defaultCurrency: 'SGD', categories: [] });
  token = registered.token;
  assert.equal(typeof token, 'string', 'Synthetic registration did not return an access token');
  const tokenPath = join(directory, 'token'); writeFileSync(tokenPath, token, { mode: 0o600 });
  const old = await request('/api/v1/accounts/add.json', { name: '日常支出', category: 1, type: 1, icon: '1', color: '1e88e5', currency: 'SGD', balance: 0 });
  const primary = await request('/api/v1/transaction/categories/add.json', { name: '食品酒水', type: 2, parentId: '0', icon: '1', color: '1e88e5' });
  await request('/api/v1/transaction/categories/add.json', { name: '早午晚餐', type: 2, parentId: primary.id, icon: '1', color: '1e88e5' });
  const plan = await runMulticurrencyAccountPreparation({ serverBaseUrl: origin, tokenPath });
  assert.equal(plan.action, 'create');
  const created = await runMulticurrencyAccountPreparation({ serverBaseUrl: origin, tokenPath, applySha256: plan.planSha256 });
  assert.equal(created.action, 'already_complete'); assert.equal(created.childCount, 159);
  const after = await request('/api/v1/accounts/list.json');
  assert.deepEqual(after.find((a) => a.id === old.id), old);
  assert.equal(prepareMulticurrencyAccounts(after).action, 'already_complete');
  // Inject test-only platform evidence to exercise the loopback API adapter from
  // macOS; production startup continues to require the immutable Linux marker.
  const deployment = resolveDeploymentProfile({ deploymentProfile: 'isolated-test', serverBaseUrl: origin, ...TEST_PATHS },
    { commands: { ownerAllowFrom: [TEST_OWNER] }, channels: { 'openclaw-weixin': { enabled: false } } },
    { platform: 'linux', environment: { CLAWBOT_DEPLOYMENT_PROFILE: 'isolated-test', OPENCLAW_STATE_DIR: '/var/lib/clawbot-test/openclaw' },
      evidence: () => ({ profile: 'isolated-test', project: 'clawbot-test', ledgerServerId: 1, owner: TEST_OWNER, origin }) });
  const api = new EzBookkeepingApi({ serverBaseUrl: origin, tokenPath, deployment });
  const store = new SqliteReceiptStore(':memory:');
  const time = Math.floor(Date.now() / 1000);
  try {
    for (const currency of CURRENCY_CODES) {
      const result = await recordExpense({ api, store,
        input: { amount: '35', currency, timeMode: 'received', primaryCategory: '食品酒水', subcategory: '早午晚餐' },
        inbound: { channel: 'synthetic', messageId: `original-${currency}`, content: `午饭35${currency}`, timestamp: time } });
      assert.equal(result.status, 'created', currency);
    }
    const accounts = await api.listExpenseAccounts('日常支出');
    const rows = await api.listScopedExpenseTransactions({ accounts, startTime: time - 1, endTime: time + 1 });
    assert.equal(rows.length, 159); assert.equal(new Set(rows.map((r) => r.currency)).size, 159);
    assert.ok(rows.every((r) => r.sourceAmount === 3500));
    const history = await api.listExpenseHistory({ accounts, limit: 10 });
    assert.equal(history.transactions.length, 10); assert.equal(history.hasMore, true);
    const results = await answerBookkeepingQuestions({ api, questions: [
      { kind: 'summary', period: 'today', currency: 'CNY', convertTo: ['CNY'] },
      { kind: 'find', currency: 'JPY', amount: '35' }, { kind: 'history', limit: 3 },
    ] });
    assert.equal(results.details.status, 'ok'); assert.equal(results.details.answers.length, 3);
    console.log(JSON.stringify({ status: 'passed', ezBookkeeping: '1.6.1', originalCurrencyWrites: rows.length,
      preservedLegacy: true, accountProvisioning: '159 children verified', history: '10 rows plus continuation', batchAnswers: 3,
      productionTouched: false }));
  } finally { store.close(); }
} finally {
  if (containerId) {
    const actual = JSON.parse(docker(['inspect', containerId]))[0];
    assert.equal(actual.Config.Labels['clawbot.acceptance'], containerName);
    docker(['stop', containerId]);
    docker(['rm', containerId]);
  }
  rmSync(directory, { recursive: true, force: true });
}
