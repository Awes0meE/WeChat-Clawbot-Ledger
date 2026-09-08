import assert from 'node:assert/strict';
import { readFileSync, existsSync, statfsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import { readProductionDashboardRelease } from './production-dashboard-release.mjs';
import { productionStatusAdapter } from './production-status-adapter.mjs';
import { operationsRoot } from './operation-lock.mjs';
import { statusHttpServer } from './status-http.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const { release } = readProductionDashboardRelease(root);
const verify = process.argv[2] === '--verify-inactive';
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && verify));
if (verify) assert.ok(!existsSync(join(operationsRoot, 'production-enabled.json')));
const adapter = productionStatusAdapter(release.hostDirectory, { backgroundChecks: true }), exec = promisify(execFile);
const assets = new Map([
  ['/', { type: 'text/html; charset=utf-8', body: readFileSync(join(root, 'deploy/dashboard/production.html')) }],
  ['/production.js', { type: 'text/javascript; charset=utf-8', body: readFileSync(join(root, 'deploy/dashboard/production.js')) }],
  ['/dashboard.css', { type: 'text/css; charset=utf-8', body: readFileSync(join(root, 'deploy/dashboard/dashboard.css')) }],
]);
let snapshot = { version: 1, profile: 'production', state: 'checking', updatedAt: null, boundaryHealthy: false, services: [] };
let refreshing = false, closing = false;
async function refresh() {
  if (refreshing || closing) return; refreshing = true;
  try {
    const result = await adapter.collect();
    const disk = statfsSync(os.homedir());
    result.immediatelyFreeBytes = disk.bavail * disk.bsize; result.uptimeSeconds = Math.floor(os.uptime());
    result.acPower = null;
    try { result.acPower = (await exec('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 5000, maxBuffer: 8192 })).stdout.includes("'AC Power'"); } catch {}
    snapshot = { ...result, dashboardSourceCommit: release.sourceCommit, dashboardTaskSha256: release.taskSha256 };
  } catch { snapshot = { version: 1, profile: 'production', state: 'inspection-unavailable', updatedAt: new Date().toISOString(), boundaryHealthy: false, services: [] }; }
  finally { refreshing = false; }
}
const server = statusHttpServer({ assets, snapshot: () => snapshot });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(verify ? 0 : 18990, '127.0.0.1', resolve); });
server.on('error', () => { console.error('CLAWBOT_PRODUCTION_DASHBOARD_UNAVAILABLE'); process.exitCode = 1; shutdown(); });
let timer;
async function shutdown() {
  if (closing) return; closing = true; clearInterval(timer); server.close(); server.closeAllConnections();
  const wait = setInterval(() => { if (!refreshing && !adapter.checksPending) { clearInterval(wait); process.exit(process.exitCode ?? 0); } }, 100);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, shutdown);
await refresh();
if (verify) {
  let step = 'status';
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(url + '/status.json'), state = await response.json();
    assert.equal(response.status, 200); assert.equal(state.state, 'disabled'); assert.equal(state.boundaryHealthy, false);
    assert.equal(state.authorizationChecking, false); assert.equal(state.businessWrites, false);
    assert.equal(state.dashboardSourceCommit, release.sourceCommit); assert.equal(state.dashboardTaskSha256, release.taskSha256);
    step = 'html'; assert.match(await (await fetch(url)).text(), /生产运行状态/);
    step = 'post';
    assert.equal((await fetch(url + '/status.json', { method: 'POST' })).status, 405);
    step = 'origin'; assert.equal((await fetch(url + '/status.json', { headers: { Origin: 'https://example.invalid' } })).status, 403);
    step = 'host';
    // Node fetch can replace a caller-supplied Host. Use the HTTP transport
    // directly so this assertion actually sends the untrusted authority.
    const wrongHost = await new Promise((resolve, reject) => {
      const request = httpRequest(url + '/status.json', { headers: { Host: 'example.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.setTimeout(5000, () => request.destroy(Error('timeout'))); request.end();
    });
    assert.equal(wrongHost, 403);
    step = 'head'; const head = await fetch(url + '/status.json', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    step = 'metadata'; assert.equal((await fetch(url + '/dashboard-release.json')).status, 404);
    assert.ok(!existsSync(join(operationsRoot, 'production-enabled.json')));
    console.log('CLAWBOT_PRODUCTION_DASHBOARD_HTTP_DISABLED_BOUNDARIES_VERIFIED');
  } catch { console.error('CLAWBOT_PRODUCTION_DASHBOARD_HTTP_CHECK_FAILED:' + step); process.exitCode = 1; }
  finally { shutdown(); }
} else {
  console.log('CLAWBOT_PRODUCTION_DASHBOARD_READY'); timer = setInterval(refresh, 5000);
}
