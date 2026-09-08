import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { dashboardJob, dashboardPortOwner } from './dashboard-job.mjs';
import { readTestHostRelease } from './test-host-release.mjs';
import { readProductionDashboardRelease } from './production-dashboard-release.mjs';

export function dashboardSwitchTargets(directory, oldBytes) {
  assert.ok(Buffer.isBuffer(oldBytes) && oldBytes.length < 16384);
  assert.ok(directory.startsWith(join(homedir(), 'Library/Application Support/Clawbot/production-dashboard-releases') + '/')
    && realpathSync(directory) === directory);
  const { release } = readProductionDashboardRelease(directory);
  function command(file, args, input) {
    const r = spawnSync(file, args, { input, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    assert.equal(r.status, 0); return r.stdout;
  }
  const old = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], oldBytes));
  const oldCommit = old.WorkingDirectory?.split('/').at(-1), oldRelease = readTestHostRelease(oldCommit);
  const previous = dashboardJob({ Label: 'com.clawbot.mac-test-host',
    ProgramArguments: [process.execPath, join(oldRelease.directory, 'scripts/mac/host-service.mjs')],
    WorkingDirectory: oldRelease.directory, RunAtLoad: true, KeepAlive: true, ThrottleInterval: 30,
    ProcessType: 'Background', StandardOutPath: '/dev/null', StandardErrorPath: '/dev/null' }, oldBytes);
  const next = dashboardJob({ Label: 'com.clawbot.mac-production-dashboard',
    ProgramArguments: [process.execPath, join(directory, 'scripts/mac/production-status-server.mjs')],
    RunAtLoad: true, KeepAlive: true, ThrottleInterval: 30, StandardOutPath: '/dev/null', StandardErrorPath: '/dev/null' },
  readFileSync(join(directory, 'dashboard.plist')));
  const port = 18990;
  function previousOwner() {
    previous.installed(); const host = previous.loaded(), pid = dashboardPortOwner(port);
    assert.ok(pid);
    assert.equal(command('/bin/ps', ['-p', String(pid), '-o', 'command=']).trim(),
      `${process.execPath} ${join(oldRelease.directory, 'scripts/mac/status-server.mjs')}`);
    assert.equal(Number(command('/bin/ps', ['-p', String(pid), '-o', 'ppid=']).trim()), host.pid);
    return pid;
  }
  async function waitFor(check) {
    const until = Date.now() + 60000;
    while (Date.now() < until) { try { await check(); return; } catch {} await delay(500); }
    throw Error('CLAWBOT_DASHBOARD_READINESS_TIMEOUT');
  }
  async function page() {
    const r = await fetch(`http://127.0.0.1:${port}/status.json`, { signal: AbortSignal.timeout(3000) });
    assert.equal(r.status, 200); const p = await r.json(), age = Date.now() - Date.parse(p.updatedAt);
    assert.ok(age >= 0 && age < 15000); return p;
  }
  const verifyPrevious = () => waitFor(async () => {
    previousOwner(); const p = await page();
    assert.equal(p.hostSourceCommit, oldCommit); assert.equal(p.receiverOnMac, false);
    assert.equal(p.boundaryHealthy, true);
  });
  return { release, oldCommit, previous, next, previousOwner, verifyPrevious, waitFor,
    assertKnownListener: () => {
      const pid = dashboardPortOwner(port);
      if (pid === null) return;
      const live = next.loaded(false);
      if (live?.pid === pid && !live.starting) next.installed();
      else previousOwner();
    },
    verifyNext: () => waitFor(async () => {
      next.installed(); assert.equal(dashboardPortOwner(port), next.loaded().pid);
      const p = await page(); assert.equal(p.profile, 'production'); assert.equal(p.boundaryHealthy, true);
      assert.equal(p.dashboardSourceCommit, release.sourceCommit); assert.equal(p.dashboardTaskSha256, release.taskSha256);
    }),
    removeNextIfOwned: async () => {
      if (next.loaded(false)) { next.installed(); await next.stop(); }
      next.remove();
    },
    restorePrevious: () => {
      if (dashboardPortOwner(port) !== null) previousOwner();
      previous.restore();
    },
  };
}
