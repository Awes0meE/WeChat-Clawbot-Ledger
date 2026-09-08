import assert from 'node:assert/strict';
import { readFileSync, lstatSync, realpathSync, existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dashboardPortOwner } from './dashboard-job.mjs';
import { switchDashboard } from './dashboard-switch.mjs';
import { dashboardSwitchTargets } from './dashboard-switch-targets.mjs';
import { readTestHostRelease } from './test-host-release.mjs';
import { readProductionDashboardRelease } from './production-dashboard-release.mjs';
import { productionStatusAdapter } from './production-status-adapter.mjs';
import { operationsRoot, waitForOperationLock } from './operation-lock.mjs';

// This command is for the eventual cutover window. Production must already
// be activated and healthy. It replaces only the dashboard/login jobs.
let unlock, stage = 'preflight';
try {
  assert.equal(process.argv.length, 3);
  const directory = resolve(process.argv[2]);
  assert.ok(directory.startsWith(join(homedir(), 'Library/Application Support/Clawbot/production-dashboard-releases') + '/')
    && realpathSync(directory) === directory);
  const { release } = readProductionDashboardRelease(directory);
  const adapter = productionStatusAdapter(release.hostDirectory);
  assert.equal((await adapter.boundary()).boundaryHealthy, true, 'Production must already be healthy');
  const before = await adapter.binding();
  const oldPath = join(homedir(), 'Library/LaunchAgents/com.clawbot.mac-test-host.plist');
  const s = lstatSync(oldPath);
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === process.getuid() && !(s.mode & 0o077) && s.size < 16384);
  const oldBytes = readFileSync(oldPath);
  const targets = dashboardSwitchTargets(directory, oldBytes);
  const { oldCommit, previous, next, previousOwner, verifyPrevious, waitFor } = targets;
  const port = 18990;
  await verifyPrevious();
  const journalParent = join(operationsRoot, 'dashboard-switches');
  let journal;
  function durable(name, bytes) {
    const fd = openSync(join(journal, name), 'wx', 0o400);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    const dir = openSync(journal, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  const releaseLock = () => { if (unlock) { unlock(); unlock = undefined; } };
  const result = await switchDashboard({
    preflight: async () => {
      unlock = await waitForOperationLock('production-dashboard-switch');
      assert.deepEqual(readProductionDashboardRelease(directory).release, release);
      readTestHostRelease(oldCommit); previousOwner(); previous.installed();
      assert.ok(!existsSync(next.plist)); assert.equal(next.loaded(false), null);
      assert.deepEqual(await adapter.binding(), before);
    },
    record: state => {
      if (state === 'started') {
        mkdirSync(journalParent, { recursive: true, mode: 0o700 });
        const st = lstatSync(journalParent);
        assert.ok(st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid()
          && !(st.mode & 0o077) && realpathSync(journalParent) === journalParent);
        journal = join(journalParent, randomUUID()); mkdirSync(journal, { mode: 0o700 });
        const parent = openSync(journalParent, 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
        durable('previous.plist', previous.bytes);
        durable('switch.json', JSON.stringify({ version: 2, purpose: 'dashboard-switch', operationPid: process.pid, directory,
          oldCommit, sourceCommit: release.sourceCommit, taskSha256: release.taskSha256 }));
      }
      durable(`${state}.json`, JSON.stringify({ version: 1, state, updatedAt: new Date().toISOString() })); stage = state;
    },
    retirePrevious: async () => { previous.installed(); previousOwner(); await previous.stop(); previous.remove(); },
    assertVacant: () => waitFor(() => assert.equal(dashboardPortOwner(port), null)),
    installNext: () => { next.write(); next.start(); },
    releaseLock,
    acquireLock: async () => { unlock ??= await waitForOperationLock('production-dashboard-rollback'); },
    verifyNext: targets.verifyNext,
    verifyProductionUnchanged: async () => {
      await waitFor(async () => assert.equal((await adapter.boundary()).boundaryHealthy, true));
      assert.deepEqual(await adapter.binding(), before);
    },
    removeNextIfOwned: targets.removeNextIfOwned,
    restorePrevious: targets.restorePrevious,
    verifyPrevious,
  });
  console.log(JSON.stringify({ ...result, journal }));
  if (result.status !== 'CLAWBOT_DASHBOARD_SWITCHED') process.exitCode = 2;
} catch { console.error(`CLAWBOT_PRODUCTION_DASHBOARD_SWITCH_REFUSED:${stage}`); process.exitCode = 1; }
finally { unlock?.(); }
