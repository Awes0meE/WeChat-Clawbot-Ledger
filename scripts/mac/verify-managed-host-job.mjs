import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { managedHostJob, atomicPrivateReplace } from './managed-host-job.mjs';
import { waitForOperationLock } from './operation-lock.mjs';
const unlock = await waitForOperationLock('managed-host-job-rehearsal');
const folder = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-host-job-')));
const label = `com.clawbot.recovery-rehearsal-${randomBytes(6).toString('hex')}`, jobs = [];
let current;
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
try {
  for (const name of ['a', 'b']) {
    const directory = join(folder, name); mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, 'production-host.mjs'), 'setInterval(() => {}, 1000);\n', { mode: 0o400 });
    writeFileSync(join(directory, `${label}.plist`), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(directory, 'production-host.mjs'))}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`, { mode: 0o400 });
    jobs.push(managedHostJob(directory, { label }));
  }
  assert.ok(!existsSync(jobs[0].plist)); mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true });
  writeFileSync(jobs[0].plist, jobs[0].bytes, { flag: 'wx', mode: 0o600 }); current = jobs[0];
  const waitLoaded = async job => { const until = Date.now() + 10000; while (Date.now() < until) {
    const loaded = job.loaded(); if (loaded.pid && !loaded.starting) return; await delay(100);
  } throw Error('Synthetic host did not start'); };
  current.start(); await waitLoaded(current);
  for (const next of [jobs[1], jobs[0]]) {
    await current.stop(); atomicPrivateReplace(current.plist, current.bytes, next.bytes); current = next;
    current.start(); await waitLoaded(current);
  }
  console.log('CLAWBOT_REAL_LAUNCHAGENT_LOAD_SWITCH_AND_REVERT_OK');
} finally {
  try { if (current) { await current.stop({ allowAbsent: true }); current.installed(); unlinkSync(current.plist); } rmSync(folder, { recursive: true, force: true }); }
  finally { unlock(); }
}
