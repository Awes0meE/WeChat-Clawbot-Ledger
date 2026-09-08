import assert from 'node:assert/strict';
import { readFileSync, lstatSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function atomicPrivateReplace(path, expectedBytes, nextBytes) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077));
  assert.deepEqual(readFileSync(path), expectedBytes, 'Managed file changed');
  const temporary = `${path}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, nextBytes); fsyncSync(fd); } finally { closeSync(fd); }
  assert.deepEqual(readFileSync(path), expectedBytes, 'Managed file changed before replacement');
  renameSync(temporary, path);
  const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function managedHostJob(directory, { label = 'com.clawbot.mac-production-host' } = {}) {
  assert.ok(label === 'com.clawbot.mac-production-host' || /^com\.clawbot\.recovery-rehearsal-[a-f0-9]{12}$/.test(label));
  const domain = `gui/${process.getuid()}`, plist = join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
  const source = join(directory, `${label}.plist`), stat = lstatSync(source);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o222) && stat.size < 16384);
  const command = (file, args) => {
    const r = spawnSync(file, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
    if (r.status !== 0) throw Error('CLAWBOT_MANAGED_HOST_JOB_COMMAND'); return r.stdout;
  };
  const expected = { Label: label, ProgramArguments: [process.execPath, join(directory, 'production-host.mjs')],
    RunAtLoad: true, KeepAlive: true, ThrottleInterval: 30, StandardOutPath: '/dev/null', StandardErrorPath: '/dev/null' };
  assert.deepEqual(JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', source])), expected);
  const bytes = readFileSync(source);
  function installed() {
    const stat = lstatSync(plist);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077));
    assert.deepEqual(readFileSync(plist), bytes, 'A different host job is installed');
  }
  function loaded({ allowAbsent = false } = {}) {
    const r = spawnSync('/bin/launchctl', ['list', label], { encoding: 'utf8', timeout: 10000 });
    if (r.status !== 0 && allowAbsent) {
      const listing = command('/bin/launchctl', ['list']);
      assert.ok(!listing.split('\n').some(line => line.trim().split(/\s+/).at(-1) === label)); return null;
    }
    assert.equal(r.status, 0, 'Managed host is not loaded');
    const args = [...(r.stdout.match(/"ProgramArguments" = \(([\s\S]*?)\);/)?.[1] ?? '').matchAll(/"([^"\n]+)";/g)].map(m => m[1]);
    assert.deepEqual(args, expected.ProgramArguments);
    const pid = r.stdout.match(/"PID" = (\d+);/)?.[1];
    let starting = false;
    if (pid) {
      const actual = command('/bin/ps', ['-p', pid, '-o', 'command=']).trim();
      starting = actual === `xpcproxy ${label}`;
      assert.ok(starting || actual === expected.ProgramArguments.join(' '), 'Loaded process does not match the verified job');
    }
    return { pid, starting };
  }
  return { plist, bytes, installed, loaded,
    async stop(options) {
      installed(); const job = loaded(options); if (!job) return;
      command('/bin/launchctl', ['bootout', `${domain}/${label}`]);
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const absent = spawnSync('/bin/launchctl', ['list', label], { encoding: 'utf8' }).status !== 0;
        const exited = !job.pid || spawnSync('/bin/ps', ['-p', job.pid, '-o', 'pid='], { encoding: 'utf8' }).status !== 0;
        if (absent && exited) return;
        await delay(250);
      }
      throw Error('CLAWBOT_MANAGED_HOST_EXIT_TIMEOUT');
    },
    start() {
      installed(); assert.equal(loaded({ allowAbsent: true }), null, 'Host is already loaded');
      command('/bin/launchctl', ['bootstrap', domain, plist]);
    },
  };
}
