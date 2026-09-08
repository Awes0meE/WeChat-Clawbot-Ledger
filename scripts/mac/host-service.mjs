import { readFileSync, lstatSync, statfsSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireOperationLock, operationsRoot } from './operation-lock.mjs';
import { verifyTestHost } from './verify-test-host.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const release = JSON.parse(readFileSync(join(root, 'release-runtime.json')));
if (release.version !== 1 || release.project !== 'clawbot-test'
  || !/^sha256:[a-f0-9]{64}$/.test(release.runtimeImage) || !/^[a-f0-9]{40}$/.test(release.sourceCommit)) throw new Error('CLAWBOT_HOST_RELEASE_INVALID');
for (const [path, hash] of Object.entries(release.files)) {
  if (!/^(scripts\/mac\/[a-z-]+\.mjs|deploy\/dashboard\/[a-z.-]+|deploy\/docker\/(compose\.test\.yml|ledger-authorization\.mjs|weixin-authorization\.mjs))$/.test(path)) throw new Error('CLAWBOT_HOST_RELEASE_PATH');
  const target = join(root, path), stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222)
    || createHash('sha256').update(readFileSync(target)).digest('hex') !== hash) throw new Error('CLAWBOT_HOST_RELEASE_HASH');
}
const exec = promisify(execFile), docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const env = { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}` };
const compose = ['compose', '-f', join(root, 'deploy/docker/compose.test.yml')];
const dashboard = spawn(process.execPath, [join(root, 'scripts/mac/status-server.mjs')], { stdio: 'inherit', env });
dashboard.on('error', () => process.exit(1));
dashboard.on('exit', () => { if (!closing) process.exit(1); });
let closing = false, working = false, retryAt = 0;
async function run(args) { return (await exec(docker, args, { cwd: root, env, timeout: 150000, maxBuffer: 1024 * 1024 })).stdout; }
function status(state) {
  const path = join(operationsRoot, 'host-status.json');
  writeFileSync(`${path}.tmp`, JSON.stringify({ version: 1, state, updatedAt: new Date().toISOString(), sourceCommit: release.sourceCommit }), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
async function tick() {
  if (working || closing) return;
  working = true; let unlock;
  try {
    unlock = acquireOperationLock('host-recovery');
    if (existsSync(join(operationsRoot, 'maintenance'))) { status('maintenance'); return; }
    try { await run(['info', '--format', '{{.ServerVersion}}']); }
    catch { status('waiting-for-docker'); return; }
    // Identity is checked even when stopped. Never adopt unknown/missing
    // containers, replaced namespaces, mutable tags or unexpected mounts.
    const before = verifyTestHost({ requireHealthy: false, runtimeImage: release.runtimeImage });
    const disk = statfsSync(homedir()), freeBytes = disk.bavail * disk.bsize;
    if (freeBytes < 5 * 2 ** 30) {
      await run([...compose, 'stop', 'openclaw', 'origin']); status('stopped-low-disk'); return;
    }
    if (freeBytes < 10 * 2 ** 30) { status('low-disk-no-restart'); return; }
    if (before.healthy) { status('healthy'); return; }
    if (Date.now() < retryAt) { status('recovery-backoff'); return; }
    retryAt = Date.now() + 5 * 60000;
    status('recovering');
    // Restart this validated pair in dependency order, including unhealthy
    // running processes. Do not retry indefinitely on credential failures.
    await run([...compose, 'stop', 'openclaw', 'origin']);
    await run([...compose, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'origin', 'openclaw']);
    verifyTestHost({ runtimeImage: release.runtimeImage });
    status('healthy');
  } catch (error) {
    if (error.message === 'CLAWBOT_OPERATION_BUSY') {
      // A backup/recovery/login operation owns the state; it controls resumption.
      try { status('another-operation'); } catch {}
    } else { try { status('identity-or-recovery-needs-attention'); } catch {} }
  } finally { unlock?.(); working = false; }
}
const timer = setInterval(tick, 15000);
await tick();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  closing = true; clearInterval(timer); dashboard.kill(signal);
  // An in-flight Docker operation must finish before releasing its lock.
  const wait = setInterval(() => { if (!working) { clearInterval(wait); process.exit(0); } }, 100);
});
