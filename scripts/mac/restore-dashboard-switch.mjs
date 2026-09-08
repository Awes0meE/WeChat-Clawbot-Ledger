import assert from 'node:assert/strict';
import { lstatSync, realpathSync, readFileSync, existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { operationsRoot, waitForOperationLock } from './operation-lock.mjs';
import { dashboardSwitchTargets } from './dashboard-switch-targets.mjs';
import { readDashboardSwitchRecord, restoreDashboardSwitch } from './dashboard-switch-record.mjs';

// Explicit recovery of an interrupted UI switch only. Never clear a retained
// global operation lock: its former owner may have left subprocesses running.
let unlock, stage = 'preflight';
try {
  assert.equal(process.argv.length, 3);
  const journal = resolve(process.argv[2]);
  assert.equal(dirname(journal), join(operationsRoot, 'dashboard-switches'));
  const { record, previousBytes } = readDashboardSwitchRecord(journal);
  const targets = dashboardSwitchTargets(record.directory, previousBytes);
  assert.equal(targets.oldCommit, record.oldCommit);
  assert.equal(targets.release.sourceCommit, record.sourceCommit);
  assert.equal(targets.release.taskSha256, record.taskSha256);
  function originalExited() {
    const r = spawnSync('/bin/ps', ['-p', String(record.operationPid), '-o', 'pid='], { encoding: 'utf8', timeout: 10000 });
    assert.ok(r.status === 1 && !r.stdout && !r.stderr, 'CLAWBOT_DASHBOARD_SWITCH_OWNER_NOT_CONFIRMED_EXITED');
  }
  originalExited();
  const parent = join(journal, 'restores'); let attempt;
  const releaseLock = () => { if (unlock) { unlock(); unlock = undefined; } };
  const result = await restoreDashboardSwitch({
    preflight: async () => {
      unlock = await waitForOperationLock('dashboard-switch-restore');
      originalExited();
      assert.deepEqual(readDashboardSwitchRecord(journal), { record, previousBytes });
      const current = dashboardSwitchTargets(record.directory, previousBytes);
      assert.deepEqual(current.release, targets.release);
      // Check both registered jobs and any remaining files before changing
      // either. A different version is never interpreted as this attempt.
      for (const job of [targets.previous, targets.next]) {
        const live = job.loaded(false);
        if (live || existsSync(job.plist)) job.installed();
      }
      targets.assertKnownListener();
      assert.deepEqual(readFileSync(join(journal, 'previous.plist')), previousBytes);
    },
    record: state => {
      if (state === 'started') {
        mkdirSync(parent, { recursive: true, mode: 0o700 });
        const st = lstatSync(parent);
        assert.ok(st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid()
          && !(st.mode & 0o077) && realpathSync(parent) === parent);
        attempt = join(parent, randomUUID()); mkdirSync(attempt, { mode: 0o700 });
        const d = openSync(parent, 'r'); try { fsyncSync(d); } finally { closeSync(d); }
      }
      const fd = openSync(join(attempt, `${state}.json`), 'wx', 0o400);
      try { writeFileSync(fd, JSON.stringify({ version: 1, state, updatedAt: new Date().toISOString() })); fsyncSync(fd); }
      finally { closeSync(fd); }
      const d = openSync(attempt, 'r'); try { fsyncSync(d); } finally { closeSync(d); }
      stage = state;
    },
    removeNextIfOwned: targets.removeNextIfOwned,
    restorePrevious: targets.restorePrevious,
    verifyPrevious: targets.verifyPrevious,
    releaseLock,
  });
  console.log(JSON.stringify({ ...result, journal, attempt }));
} catch { console.error(`CLAWBOT_DASHBOARD_SWITCH_RESTORE_REFUSED:${stage}`); process.exitCode = 1; }
finally { unlock?.(); }
