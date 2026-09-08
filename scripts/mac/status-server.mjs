import http from 'node:http';
import os from 'node:os';
import { readFileSync, statfsSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { observationRecorder } from './observation.mjs';
import { inspectModelAuthorization } from './model-authorization-inspection.mjs';
import { visibleModelAuthorization } from './model-authorization.mjs';
import { inspectLedgerAuthorization, visibleLedgerAuthorization } from './ledger-authorization-inspection.mjs';
import { inspectWeixinAuthorization, visibleWeixinAuthorization } from './weixin-authorization-inspection.mjs';
import { verifyTestHost } from './verify-test-host.mjs';

const exec = promisify(execFile);
const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const port = 18990;
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const assets = new Map([
  ['/', ['text/html; charset=utf-8', new URL('../../deploy/dashboard/index.html', import.meta.url)]],
  ['/dashboard.css', ['text/css; charset=utf-8', new URL('../../deploy/dashboard/dashboard.css', import.meta.url)]],
  ['/dashboard.js', ['text/javascript; charset=utf-8', new URL('../../deploy/dashboard/dashboard.js', import.meta.url)]],
]);
const files = new Map([...assets].map(([route, [type, url]]) => [route, { type, body: readFileSync(url) }]));
const operations = join(os.homedir(), 'Library', 'Application Support', 'Clawbot', 'operations');
let record, release;
try {
  release = JSON.parse(readFileSync(new URL('../../release-runtime.json', import.meta.url)));
  record = observationRecorder(join(operations, 'observations'), release.sourceCommit, release.runtimeImage);
} catch { /* Unpublished development pages do not collect release evidence. */ }
const hostStates = new Set(['healthy', 'maintenance', 'waiting-for-docker', 'stopped-low-disk', 'low-disk-no-restart',
  'recovering', 'recovery-backoff', 'another-operation', 'identity-or-recovery-needs-attention']);
function hostStatus() {
  try {
    const path = join(operations, 'host-status.json'), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error();
    const value = JSON.parse(readFileSync(path));
    const age = Date.now() - Date.parse(value.updatedAt);
    if (!hostStates.has(value.state) || !Number.isFinite(age) || age < 0 || age > 45000
      || (release && value.sourceCommit !== release.sourceCommit)) return 'stale';
    return value.state;
  } catch { return 'unavailable'; }
}
// Operator progress is descriptive only; it never controls production services.
function migrationProgress() {
  try {
    const path = join(operations, 'migration-progress.json'), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 2048) return null;
    const value = JSON.parse(readFileSync(path));
    const stages = {
      audit: ['1/6 · Windows 在线核验', 'SSH 与文件传输已通过；正在核验生产版本、数据、授权和空间。Windows 尚未停服。'],
      package: ['2/6 · 准备实际迁移包', '正在完成数据映射和迁移前检查。Windows 尚未停服。'],
      ready: ['等待现场停服窗口', '停服前准备已完成，等待用户在电脑旁确认后执行最终备份。'],
      snapshot: ['3/6 · Windows 停服与最终备份', '正在停止已核验的旧服务、保存最终数据并传输到 Mac。'],
      import: ['4/6 · Mac 导入与启用核验', '正在校验真实数据和授权；启用前复核 Windows 不会重新接收。'],
      acceptance: ['5/6 · 正式业务验收', '正在验证真实微信和公网账本，随后切换生产看板。'],
      backup: ['6/6 · 正式备份与旧实例退役', '正在验证异机备份并整理恢复材料。'],
    };
    if (!Object.hasOwn(stages, value.stage) || !Number.isFinite(Date.parse(value.updatedAt)) || Date.parse(value.updatedAt) > Date.now() + 60000) return null;
    return { stage: value.stage, title: stages[value.stage][0], detail: stages[value.stage][1], updatedAt: value.updatedAt };
  } catch { return null; }
}
function memoryBytes(value) {
  const match = String(value).match(/^([\d.]+)\s*(B|kB|KiB|MB|MiB|GB|GiB)$/);
  return match ? Math.round(Number(match[1]) * ({ B: 1, kB: 1000, KiB: 1024, MB: 1e6, MiB: 2 ** 20, GB: 1e9, GiB: 2 ** 30 })[match[2]]) : null;
}
let snapshot = { updatedAt: null, docker: 'checking', services: [] }, refreshing = false;
let authorization, authorizationTarget, authorizationPending = false, nextAuthorizationAt = 0;
let ledgerAuthorization, ledgerTarget, ledgerPending = false, nextLedgerAt = 0;
let weixinAuthorization, weixinTarget, weixinPending = false, nextWeixinAt = 0;
async function command(file, args) {
  return (await exec(file, args, { timeout: 8000, maxBuffer: 1024 * 1024, encoding: 'utf8',
    env: { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}` } })).stdout;
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  let authorizationExpected, ledgerExpected;
  const migration = migrationProgress();
  const next = { migration, updatedAt: new Date().toISOString(), phase: 'Mac P1–P6 准备已完成 · 下一步：Windows 交接与正式切换',
    hostState: hostStatus(), hostSourceCommit: release?.sourceCommit ?? null,
    productionHost: 'Windows（当前接管情况见迁移进度）', receiverOnMac: false,
    docker: 'unavailable', services: [], cpuCores: os.cpus().length, hostMemoryBytes: os.totalmem(),
    uptimeSeconds: Math.floor(os.uptime()), backup: { status: 'not-found' }, acPower: null };
  if (migration) next.phase = migration.title;
  try {
    const backupRoot = join(os.homedir(), 'Library', 'Application Support', 'Clawbot', 'backups');
    const records = readdirSync(backupRoot).filter((name) => /^clawbot-test-\d+-[a-f0-9]{10}$/.test(name)).flatMap((name) => {
      try {
        const folder = join(backupRoot, name), marker = join(folder, 'verified.json'), archive = join(folder, 'state.enc');
        if (lstatSync(folder).isSymbolicLink() || lstatSync(marker).isSymbolicLink() || lstatSync(archive).isSymbolicLink()
          || lstatSync(marker).size > 4096) return [];
        const value = JSON.parse(readFileSync(marker, 'utf8'));
        if (value.status !== 'restored-and-verified' || value.fileInventory !== true
          || value.ledgerAndReceiptIntegrity !== true || value.restoreNetwork !== 'none'
          || !Number.isFinite(Date.parse(value.checkedAt))) return [];
        return [{ checkedAt: new Date(value.checkedAt).toISOString(), bytes: lstatSync(archive).size }];
      } catch { return []; }
    }).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
    if (records.length) next.backup = { status: 'verified-locally', ...records[0], verifiedCopies: records.length };
  } catch {}
  try {
    const disk = statfsSync(os.homedir());
    next.immediatelyFreeBytes = disk.bavail * disk.bsize;
    next.hostDiskBytes = disk.blocks * disk.bsize;
    const [power, idsText] = await Promise.allSettled([
      command('/usr/bin/pmset', ['-g', 'batt']),
      command(docker, ['ps', '-a', '-q', '--filter', 'label=com.docker.compose.project=clawbot-test']),
    ]);
    if (power.status === 'fulfilled') next.acPower = power.value.includes("'AC Power'");
    if (idsText.status !== 'fulfilled') throw new Error('Docker unavailable');
    next.docker = 'available';
    const ids = idsText.value.trim().split('\n').filter((id) => /^[a-f0-9]{12,64}$/.test(id));
    if (ids.length) {
      const containers = JSON.parse(await command(docker, ['inspect', ...ids]));
      const own = containers.filter((c) => c.Config.Labels?.['com.docker.compose.project'] === 'clawbot-test'
        && ['origin', 'openclaw'].includes(c.Config.Labels?.['com.docker.compose.service']));
      const running = own.filter((c) => c.State.Running);
      const agent = own.filter(c => c.Config.Labels['com.docker.compose.service'] === 'openclaw');
      if (release && agent.length === 1 && agent[0].State.Running && agent[0].Image === release.runtimeImage) {
        authorizationExpected = { sourceCommit: release.sourceCommit, runtimeImage: release.runtimeImage,
          containerId: agent[0].Id, containerStartedAt: agent[0].State.StartedAt };
        const origin = own.filter(c => c.Config.Labels['com.docker.compose.service'] === 'origin');
        if (origin.length === 1 && origin[0].State.Running) ledgerExpected = { ...authorizationExpected,
          originId: origin[0].Id, originImage: origin[0].Image, originStartedAt: origin[0].State.StartedAt };
      }
      let stats = [];
      if (running.length) {
        stats = (await command(docker, ['stats', '--no-stream', '--format', '{{json .}}', ...running.map((c) => c.Id)]))
          .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      }
      next.services = own.map((c) => {
        const row = stats.find((s) => c.Id.startsWith(s.ID ?? s.Container));
        return { name: c.Config.Labels['com.docker.compose.service'], running: c.State.Running,
          health: c.State.Health?.Status ?? 'unknown', restarts: c.RestartCount,
          cpu: row?.CPUPerc ?? '—', memory: row?.MemUsage?.split(' / ')[0] ?? '—',
          publishedPorts: Object.values(c.NetworkSettings.Ports ?? {}).reduce((n, v) => n + (v?.length ?? 0), 0),
          readOnly: c.HostConfig.ReadonlyRootfs && !c.HostConfig.Privileged };
      });
    }
  } catch { next.docker = 'unavailable'; next.services = []; }
  finally {
    next.boundaryHealthy = next.hostState === 'healthy' && next.docker === 'available' && next.services.length === 2
      && next.services.every((s) => s.running && s.health === 'healthy' && s.readOnly && s.publishedPorts === 0);
    const target = authorizationExpected && JSON.stringify(authorizationExpected);
    if (target !== authorizationTarget) { authorizationTarget = target; nextAuthorizationAt = 0; }
    if (next.boundaryHealthy && authorizationExpected && !authorizationPending && Date.now() >= nextAuthorizationAt) {
      authorizationPending = true; nextAuthorizationAt = Date.now() + 5 * 60000;
      // Read-only diagnostics run independently of the five-second page refresh.
      // They never restart, log out or request a model/tool operation.
      inspectModelAuthorization({ profile: 'isolated-test', sourceCommit: release.sourceCommit,
        inspect: async () => verifyTestHost({ runtimeImage: release.runtimeImage }).openclaw })
        .then(report => { authorization = report; })
        .catch(() => { authorization = null; })
        .finally(() => { authorizationPending = false; });
    }
    next.modelAuthorization = visibleModelAuthorization(authorization, authorizationExpected);
    next.modelAuthorization.checking = authorizationPending;
    const nextLedgerTarget = ledgerExpected && JSON.stringify(ledgerExpected);
    if (nextLedgerTarget !== ledgerTarget) { ledgerTarget = nextLedgerTarget; nextLedgerAt = 0; }
    if (next.boundaryHealthy && ledgerExpected && !ledgerPending && Date.now() >= nextLedgerAt) {
      ledgerPending = true; nextLedgerAt = Date.now() + 5 * 60000;
      inspectLedgerAuthorization({ profile: 'isolated-test', sourceCommit: release.sourceCommit,
        inspect: async () => verifyTestHost({ runtimeImage: release.runtimeImage }) })
        .then(report => { ledgerAuthorization = report; })
        .catch(() => { ledgerAuthorization = null; })
        .finally(() => { ledgerPending = false; });
    }
    // Do not retain an accepted state while the runtime boundary is unhealthy.
    next.ledgerAuthorization = visibleLedgerAuthorization(ledgerAuthorization, next.boundaryHealthy ? ledgerExpected : undefined);
    next.ledgerAuthorization.checking = ledgerPending;
    if (target !== weixinTarget) { weixinTarget = target; nextWeixinAt = 0; }
    if (next.boundaryHealthy && authorizationExpected && !weixinPending && Date.now() >= nextWeixinAt) {
      weixinPending = true; nextWeixinAt = Date.now() + 5 * 60000;
      inspectWeixinAuthorization({ profile: 'isolated-test', sourceCommit: release.sourceCommit,
        inspect: async () => verifyTestHost({ runtimeImage: release.runtimeImage }).openclaw })
        .then(report => { weixinAuthorization = report; })
        .catch(() => { weixinAuthorization = null; })
        .finally(() => { weixinPending = false; });
    }
    next.weixinAuthorization = visibleWeixinAuthorization(weixinAuthorization, next.boundaryHealthy ? authorizationExpected : undefined);
    next.weixinAuthorization.checking = weixinPending;
    try {
      const memory = next.services.map((s) => memoryBytes(s.memory));
      next.observation = record ? record({ healthy: next.boundaryHealthy && next.acPower === true && next.immediatelyFreeBytes >= 10 * 2 ** 30,
        hostState: next.hostState, acPower: next.acPower, freeBytes: next.immediatelyFreeBytes,
        memoryBytes: memory.length === 2 && memory.every(Number.isSafeInteger) ? memory.reduce((a, b) => a + b, 0) : null })
        : { status: 'unavailable' };
    } catch { next.observation = { status: 'write-or-integrity-error' }; }
    snapshot = next; refreshing = false;
  }
}
const server = http.createServer((request, response) => {
  const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
  };
  if (!allowedHosts.has(request.headers.host) || (request.headers.origin
    && ![...allowedHosts].some((host) => request.headers.origin === `http://${host}`))) {
    response.writeHead(403, headers); response.end(); return;
  }
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, headers); response.end(); return; }
  const asset = request.url === '/status.json'
    ? { type: 'application/json; charset=utf-8', body: JSON.stringify(snapshot) } : files.get(request.url);
  if (!asset) { response.writeHead(404, headers); response.end(); return; }
  response.writeHead(200, { ...headers, 'Content-Type': asset.type });
  response.end(request.method === 'HEAD' ? undefined : asset.body);
});
server.on('error', () => { console.error('CLAWBOT_STATUS_SERVER_START_FAILED'); process.exit(1); });
server.listen(port, '127.0.0.1', () => console.log(`CLAWBOT_STATUS_SERVER_READY http://127.0.0.1:${port}`));
await refresh();
const timer = setInterval(refresh, 5000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  clearInterval(timer); server.close(() => process.exit(0));
});
