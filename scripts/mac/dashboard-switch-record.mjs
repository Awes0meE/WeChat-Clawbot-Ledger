import assert from 'node:assert/strict';
import { readFileSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

// Read only a complete, owner-private, immutable switch receipt. A completed
// switch is not an interrupted switch and cannot authorize this restoration.
export function readDashboardSwitchRecord(directory) {
  assert.match(basename(directory), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  const stat = lstatSync(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && !(stat.mode & 0o077) && realpathSync(directory) === directory);
  function read(name) {
    const path = join(directory, name), s = lstatSync(path);
    assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === process.getuid()
      && !(s.mode & 0o277) && s.size < 16384 && realpathSync(path) === path);
    return readFileSync(path);
  }
  assert.ok(!existsSync(join(directory, 'completed.json')), 'CLAWBOT_DASHBOARD_SWITCH_ALREADY_COMPLETED');
  const record = JSON.parse(read('switch.json'));
  assert.deepEqual(Object.keys(record).sort(), ['version', 'purpose', 'operationPid', 'directory', 'oldCommit', 'sourceCommit', 'taskSha256'].sort());
  assert.equal(record.version, 2); assert.equal(record.purpose, 'dashboard-switch');
  assert.ok(Number.isSafeInteger(record.operationPid) && record.operationPid > 0);
  assert.match(record.oldCommit, /^[a-f0-9]{40}$/); assert.match(record.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(record.taskSha256, /^[a-f0-9]{64}$/); assert.equal(typeof record.directory, 'string');
  const started = JSON.parse(read('started.json'));
  assert.deepEqual(Object.keys(started).sort(), ['version', 'state', 'updatedAt'].sort());
  assert.equal(started.version, 1); assert.equal(started.state, 'started');
  const time = Date.parse(started.updatedAt); assert.ok(Number.isFinite(time) && time <= Date.now());
  return { record, previousBytes: read('previous.plist') };
}

export async function restoreDashboardSwitch(actions) {
  try {
    await actions.preflight();
    await actions.record('started');
    await actions.removeNextIfOwned();
    await actions.restorePrevious();
    await actions.releaseLock();
    await actions.verifyPrevious();
    await actions.record('restored');
    return { status: 'CLAWBOT_INTERRUPTED_DASHBOARD_PREVIOUS_RESTORED', productionOperationsPerformed: false };
  } finally { await actions.releaseLock(); }
}
