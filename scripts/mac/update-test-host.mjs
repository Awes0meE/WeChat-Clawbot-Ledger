import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForOperationLock, operationsRoot } from './operation-lock.mjs';
import { verifyTestHost } from './verify-test-host.mjs';
import { readTestHostRelease as readRelease } from './test-host-release.mjs';

// This operation updates only the known test dashboard/recovery LaunchAgent.
// Both directions use this same validation; it never replaces runtime images
// or data volumes, and cannot install a production job.
const commit = process.argv[2];
assert.match(commit ?? '', /^[a-f0-9]{40}$/, 'Supply a prepared host source commit');
const rehearseFailure = process.argv[3] === '--verify-failure-rollback';
assert.ok(process.argv.length <= 4);
if (process.argv[3] && !rehearseFailure) throw new Error('Unknown host update option');
const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.clawbot.mac-test-host.plist');
const domain = `gui/${process.getuid()}`, label = 'com.clawbot.mac-test-host';
function run(file, args, input) {
  const result = spawnSync(file, args, { input, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error('CLAWBOT_HOST_UPDATE_COMMAND_FAILED');
  return result.stdout;
}

const newRelease = readRelease(commit);
const plistStat = lstatSync(plist);
assert.ok(plistStat.isFile() && !plistStat.isSymbolicLink() && plistStat.uid === process.getuid() && !(plistStat.mode & 0o077));
const oldBytes = readFileSync(plist), old = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]));
const oldCommit = old.WorkingDirectory?.split('/').at(-1), oldRelease = readRelease(oldCommit);
assert.notEqual(commit, oldCommit, 'This release is already installed');
const expected = { Label: label, ProgramArguments: [process.execPath, join(oldRelease.directory, 'scripts/mac/host-service.mjs')],
  WorkingDirectory: oldRelease.directory, RunAtLoad: true, KeepAlive: true, ThrottleInterval: 30, ProcessType: 'Background',
  StandardOutPath: '/dev/null', StandardErrorPath: '/dev/null' };
assert.deepEqual(old, expected, 'Unknown LaunchAgent configuration');
assert.equal(newRelease.release.runtimeImage, oldRelease.release.runtimeImage, 'Runtime changes require their own data/recovery workflow');
let unlock = await waitForOperationLock('test-host-update'), switched = false;
async function waitHealthy(id) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const status = JSON.parse(readFileSync(join(operationsRoot, 'host-status.json')));
      if (status.sourceCommit === id && status.state === 'healthy' && Date.now() - Date.parse(status.updatedAt) < 30000) {
        const response = await fetch('http://127.0.0.1:18990/status.json', { signal: AbortSignal.timeout(3000) });
        const page = await response.json();
        if (response.ok && page.docker === 'available' && page.services?.length === 2
          && (page.hostSourceCommit === undefined || page.hostSourceCommit === id)) return;
      }
    } catch {}
    await delay(1000);
  }
  throw new Error('CLAWBOT_HOST_UPDATE_HEALTH_TIMEOUT');
}
function replace(bytes) {
  const temporary = `${plist}.${randomUUID()}.clawbot-update`;
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try { run('/usr/bin/plutil', ['-lint', temporary]); renameSync(temporary, plist); }
  finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function assertLoaded(directory, allowExited = false) {
  const loaded = run('/bin/launchctl', ['list', label]);
  const argumentsText = loaded.match(/"ProgramArguments" = \(([\s\S]*?)\);/)?.[1];
  assert.ok(argumentsText, 'Missing loaded job arguments');
  const args = [...argumentsText.matchAll(/"([^"\n]+)";/g)].map((m) => m[1]);
  assert.deepEqual(args, [process.execPath, join(directory, 'scripts/mac/host-service.mjs')]);
  const match = loaded.match(/"PID" = (\d+);/);
  if (!match && allowExited) return;
  assert.ok(match, 'Known host is not running');
  const command = run('/bin/ps', ['-p', match[1], '-o', 'command=']).trim();
  assert.equal(command, `${process.execPath} ${join(directory, 'scripts/mac/host-service.mjs')}`, 'Loaded process does not match inspected host');
}
async function waitUnloaded() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (spawnSync('/bin/launchctl', ['list', label], { encoding: 'utf8' }).status !== 0) return;
    await delay(250);
  }
  throw new Error('CLAWBOT_HOST_UNLOAD_TIMEOUT');
}
try {
  verifyTestHost({ runtimeImage: oldRelease.release.runtimeImage }); assertLoaded(oldRelease.directory);
  assert.deepEqual(readFileSync(plist), oldBytes, 'Installed job changed during preflight');
  const backups = join(operationsRoot, 'host-updates'); mkdirSync(backups, { recursive: true, mode: 0o700 });
  writeFileSync(join(backups, `${Date.now()}-${oldCommit}.plist`), oldBytes, { flag: 'wx', mode: 0o400 });
  const updated = { ...expected, ProgramArguments: [process.execPath, join(newRelease.directory, 'scripts/mac/host-service.mjs')], WorkingDirectory: newRelease.directory };
  const xml = run('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', '-'], JSON.stringify(updated));
  run('/bin/launchctl', ['bootout', `${domain}/${label}`]); switched = true;
  await waitUnloaded();
  replace(xml); run('/bin/launchctl', ['bootstrap', domain, plist]);
  unlock(); unlock = null;
  if (rehearseFailure) throw new Error('CLAWBOT_TEST_HOST_INJECTED_UPDATE_FAILURE');
  await waitHealthy(commit); verifyTestHost({ runtimeImage: newRelease.release.runtimeImage });
  console.log(JSON.stringify({ status: 'CLAWBOT_TEST_HOST_UPDATED', from: oldCommit, to: commit, runtimeImageUnchanged: true }));
} catch (error) {
  if (switched) {
    unlock ??= await waitForOperationLock('test-host-rollback');
    const loaded = spawnSync('/bin/launchctl', ['list', label], { encoding: 'utf8' });
    if (loaded.status === 0) {
      // An unload failure can leave the already-validated old job exiting.
      // Never mistake that transient state for an unknown replacement job.
      if (loaded.stdout.includes(oldRelease.directory)) { assertLoaded(oldRelease.directory, true); await waitUnloaded(); }
      else { assertLoaded(newRelease.directory, true); run('/bin/launchctl', ['bootout', `${domain}/${label}`]); await waitUnloaded(); }
    }
    replace(oldBytes); run('/bin/launchctl', ['bootstrap', domain, plist]);
    unlock(); unlock = null; await waitHealthy(oldCommit);
    console.error('CLAWBOT_TEST_HOST_ROLLED_BACK');
  }
  if (rehearseFailure && error.message === 'CLAWBOT_TEST_HOST_INJECTED_UPDATE_FAILURE') {
    verifyTestHost({ runtimeImage: oldRelease.release.runtimeImage });
    console.log('CLAWBOT_TEST_HOST_FAILED_UPDATE_RECOVERY_VERIFIED');
  } else throw error;
} finally { unlock?.(); }
