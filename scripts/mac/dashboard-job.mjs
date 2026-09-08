import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

function command(file, args, input) {
  const r = spawnSync(file, args, { input, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  assert.equal(r.status, 0, 'CLAWBOT_DASHBOARD_JOB_COMMAND_FAILED'); return r.stdout;
}
export function dashboardJob(expected, bytes) {
  const label = expected.Label;
  assert.ok(['com.clawbot.mac-test-host', 'com.clawbot.mac-production-dashboard'].includes(label)
    || /^com\.clawbot\.dashboard-rehearsal-[a-f0-9]{12}-(old|new)$/.test(label));
  assert.deepEqual(JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], bytes)), expected);
  const plist = join(homedir(), 'Library/LaunchAgents', `${label}.plist`), domain = `gui/${process.getuid()}`;
  function installed() {
    const stat = lstatSync(plist);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077));
    assert.deepEqual(readFileSync(plist), bytes, 'CLAWBOT_DASHBOARD_TASK_CHANGED');
  }
  function loaded(requireRunning = true, verifyProcess = true) {
    const r = spawnSync('/bin/launchctl', ['list', label], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    if (r.status !== 0) {
      const all = command('/bin/launchctl', ['list']);
      assert.ok(!all.split('\n').some(line => line.trim().split(/\s+/).at(-1) === label)); return null;
    }
    const args = [...(r.stdout.match(/"ProgramArguments" = \(([\s\S]*?)\);/)?.[1] ?? '').matchAll(/"([^"\n]+)";/g)].map(m => m[1]);
    assert.deepEqual(args, expected.ProgramArguments, 'CLAWBOT_DASHBOARD_PROCESS_CHANGED');
    const pid = Number(r.stdout.match(/"PID" = (\d+);/)?.[1]);
    if (requireRunning) assert.ok(Number.isSafeInteger(pid) && pid > 0, 'CLAWBOT_DASHBOARD_NOT_RUNNING');
    let starting = false;
    if (pid && verifyProcess) {
      const info = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'state=', '-o', 'command='], { encoding: 'utf8', timeout: 10000 });
      if (info.status === 1 && !info.stdout && !info.stderr) {
        // launchctl can briefly retain a PID after that exact process exits.
        assert.equal(requireRunning, false, 'CLAWBOT_DASHBOARD_NOT_RUNNING');
      } else {
        assert.equal(info.status, 0);
        const [, state, actual] = info.stdout.trim().match(/^(\S+)\s+(.+)$/) ?? [];
        assert.ok(state && actual);
        starting = actual === `xpcproxy ${label}`;
        if (state.includes('Z')) assert.equal(requireRunning, false, 'CLAWBOT_DASHBOARD_EXITED');
        else assert.ok(starting || actual === expected.ProgramArguments.join(' '), 'CLAWBOT_DASHBOARD_PROCESS_CHANGED');
      }
    }
    if (requireRunning) assert.equal(starting, false, 'CLAWBOT_DASHBOARD_STARTING');
    return { pid: pid || null, starting };
  }
  return { label, plist, bytes, installed, loaded,
    async stop() {
      const live = loaded(false); if (!live) return;
      installed();
      command('/bin/launchctl', ['bootout', `${domain}/${label}`]);
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        // After bootout, process command text can disappear before launchctl
        // unregisters the task. Continue validating its registered arguments;
        // completion requires both task absence and the original PID's exit.
        const absent = loaded(false, false) === null;
        let exited = !live.pid;
        if (live.pid) {
          const check = spawnSync('/bin/ps', ['-p', String(live.pid), '-o', 'pid='], { encoding: 'utf8', timeout: 10000 });
          exited = check.status === 1 && !check.stdout && !check.stderr;
          assert.ok(check.status === 0 || exited, 'CLAWBOT_DASHBOARD_EXIT_CHECK_FAILED');
        }
        if (absent && exited) return;
        await delay(250);
      }
      throw Error('CLAWBOT_DASHBOARD_STOP_TIMEOUT');
    },
    remove() {
      assert.equal(loaded(false), null);
      if (existsSync(plist)) { installed(); unlinkSync(plist); }
    },
    write() { assert.ok(!existsSync(plist)); writeFileSync(plist, bytes, { flag: 'wx', mode: 0o600 }); installed(); },
    start() { installed(); assert.equal(loaded(false), null); command('/bin/launchctl', ['bootstrap', domain, plist]); },
    restore() { if (!existsSync(plist)) this.write(); else installed(); if (!loaded(false)) this.start(); },
  };
}
export function dashboardPortOwner(port) {
  assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536);
  const r = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  if (r.status === 1 && !r.stdout && !r.stderr) return null;
  assert.equal(r.status, 0); assert.equal(r.stderr, '');
  const pids = [...new Set(r.stdout.split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))];
  assert.equal(pids.length, 1, 'CLAWBOT_DASHBOARD_PORT_OWNERSHIP_UNKNOWN'); return pids[0];
}
