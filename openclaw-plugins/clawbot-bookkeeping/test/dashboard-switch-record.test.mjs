import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, realpathSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readDashboardSwitchRecord, restoreDashboardSwitch } from '../../../scripts/mac/dashboard-switch-record.mjs';

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-switch-record-'))), directory = join(base, randomUUID());
  mkdirSync(directory, { mode: 0o700 }); t.after(() => rmSync(base, { recursive: true, force: true }));
  const record = { version: 2, purpose: 'dashboard-switch', operationPid: 12345, directory: '/synthetic/candidate',
    oldCommit: 'a'.repeat(40), sourceCommit: 'b'.repeat(40), taskSha256: 'c'.repeat(64) };
  const started = { version: 1, state: 'started', updatedAt: new Date().toISOString() };
  function put(name, value) { const p = join(directory, name); try { unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value), { flag: 'wx', mode: 0o400 }); }
  put('switch.json', record); put('started.json', started); put('previous.plist', 'synthetic previous task');
  return { directory, record, started, put };
}
test('complete private started receipt supplies only the recorded switch and original task', { skip: process.platform === 'win32' ? 'Requires macOS host uid and POSIX permissions' : false }, t => {
  const f = fixture(t), value = readDashboardSwitchRecord(f.directory);
  assert.deepEqual(value.record, f.record); assert.equal(value.previousBytes.toString(), 'synthetic previous task');
});
test('completed switches and incomplete or future started records do not authorize interrupted recovery', { skip: process.platform === 'win32' ? 'Requires macOS host uid and POSIX permissions' : false }, t => {
  const f = fixture(t);
  f.put('completed.json', {}); assert.throws(() => readDashboardSwitchRecord(f.directory), /ALREADY_COMPLETED/);
  unlinkSync(join(f.directory, 'completed.json'));
  for (const value of [{ ...f.started, state: 'completed' }, { ...f.started, updatedAt: new Date(Date.now() + 3600000).toISOString() }, '{}']) {
    f.put('started.json', value); assert.throws(() => readDashboardSwitchRecord(f.directory));
  }
});
test('unknown schemas, legacy records without owner pid and changed source identifiers are refused', { skip: process.platform === 'win32' ? 'Requires macOS host uid and POSIX permissions' : false }, t => {
  const f = fixture(t);
  for (const record of [{ ...f.record, version: 1 }, { ...f.record, operationPid: 0 },
    { ...f.record, oldCommit: 'wrong' }, { ...f.record, extra: true }]) {
    f.put('switch.json', record); assert.throws(() => readDashboardSwitchRecord(f.directory));
  }
});
test('writable, shared and symlinked records cannot authorize task changes', { skip: process.platform === 'win32' ? 'Requires macOS host uid and POSIX permissions' : false }, t => {
  const f = fixture(t), path = join(f.directory, 'previous.plist');
  for (const mode of [0o600, 0o440]) { chmodSync(path, mode); assert.throws(() => readDashboardSwitchRecord(f.directory)); }
  chmodSync(path, 0o400); const bytes = readFileSync(path); unlinkSync(path);
  f.put('other', bytes.toString()); symlinkSync(join(f.directory, 'other'), path);
  assert.throws(() => readDashboardSwitchRecord(f.directory));
});
test('interrupted recovery restores the previous task and leaves incomplete attempts resumable', async () => {
  for (const initial of ['previous', 'vacant', 'next']) {
    let listener = initial, locked = false; const records = [];
    const actions = {
      preflight: () => { locked = true; }, record: s => records.push(s),
      removeNextIfOwned: () => { if (listener === 'next') listener = 'vacant'; },
      restorePrevious: () => { assert.ok(['vacant', 'previous'].includes(listener)); listener = 'previous'; },
      releaseLock: () => { locked = false; }, verifyPrevious: () => { assert.equal(locked, false); assert.equal(listener, 'previous'); },
    };
    const r = await restoreDashboardSwitch(actions); assert.equal(r.productionOperationsPerformed, false);
    assert.deepEqual(records, ['started', 'restored']); assert.equal(locked, false);
    // Repeating a verified restoration makes no new business operation.
    await restoreDashboardSwitch(actions); assert.equal(listener, 'previous');
    actions.removeNextIfOwned = () => { throw Error('unknown task'); }; records.length = 0;
    await assert.rejects(restoreDashboardSwitch(actions), /unknown task/);
    assert.deepEqual(records, ['started']); assert.equal(locked, false);
  }
});
