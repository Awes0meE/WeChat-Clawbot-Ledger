import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { dashboardJob, dashboardPortOwner } from './dashboard-job.mjs';
import { switchDashboard } from './dashboard-switch.mjs';
import { waitForOperationLock } from './operation-lock.mjs';
import { restoreDashboardSwitch } from './dashboard-switch-record.mjs';

// Unique rehearsal jobs, an ephemeral loopback port and a private lock.
// Neither live dashboard label nor the live observation lock is touched.
const folder = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-dashboard-switch-')));
const nonce = randomBytes(6).toString('hex'), jobs = [];
let unlock;
try {
  const reservation = createServer();
  await new Promise((yes, no) => { reservation.once('error', no); reservation.listen(0, '127.0.0.1', yes); });
  const port = reservation.address().port;
  await new Promise(yes => reservation.close(yes));
  for (const name of ['old', 'new']) {
    const label = `com.clawbot.dashboard-rehearsal-${nonce}-${name}`, script = join(folder, `${name}.mjs`);
    writeFileSync(script, `import { createServer } from 'node:http';
const server = createServer((q,r) => { r.setHeader('Content-Type','application/json'); r.end(JSON.stringify({name:${JSON.stringify(name)}})); });
server.listen(${port},'127.0.0.1');
process.on('SIGTERM',() => { server.close(() => process.exit()); server.closeAllConnections(); });
`, { flag: 'wx', mode: 0o400 });
    const expected = { Label: label, ProgramArguments: [process.execPath, script], RunAtLoad: true, KeepAlive: true,
      ThrottleInterval: 30, StandardOutPath: '/dev/null', StandardErrorPath: '/dev/null' };
    const r = spawnSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', '-'], { input: JSON.stringify(expected), encoding: 'utf8' });
    assert.equal(r.status, 0); jobs.push(dashboardJob(expected, Buffer.from(r.stdout)));
  }
  mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true });
  for (const job of jobs) { assert.ok(!existsSync(job.plist)); assert.equal(job.loaded(false), null); }
  const [previous, next] = jobs;
  const lock = async () => { unlock ??= await waitForOperationLock('dashboard-rehearsal', { directory: join(folder, 'operations') }); };
  const release = () => { if (unlock) { unlock(); unlock = undefined; } };
  async function verify(job, name) {
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      try {
        job.installed(); assert.equal(dashboardPortOwner(port), job.loaded().pid);
        const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) });
        assert.deepEqual(await response.json(), { name }); return;
      } catch {} await delay(100);
    }
    throw Error('CLAWBOT_DASHBOARD_REHEARSAL_READINESS');
  }
  async function restore() {
    const pid = dashboardPortOwner(port);
    if (pid !== null) { previous.installed(); assert.equal(pid, previous.loaded().pid); }
    previous.restore();
  }
  assert.equal(dashboardPortOwner(port), null); previous.write(); previous.start(); await verify(previous, 'old');
  const records = [];
  const actions = {
    preflight: async () => { await verify(previous, 'old'); await lock(); assert.equal(next.loaded(false), null); assert.ok(!existsSync(next.plist)); },
    record: state => { records.push(state); },
    retirePrevious: async () => { await previous.stop(); previous.remove(); },
    assertVacant: () => assert.equal(dashboardPortOwner(port), null),
    installNext: () => { next.write(); next.start(); },
    releaseLock: release, acquireLock: lock,
    verifyNext: () => verify(next, 'new'),
    verifyProductionUnchanged: () => { assert.equal(unlock, undefined); },
    removeNextIfOwned: async () => { await next.stop(); next.remove(); },
    restorePrevious: restore,
    verifyPrevious: () => verify(previous, 'old'),
  };
  const diagnosed = Object.fromEntries(Object.entries(actions).map(([name, action]) => [name, async (...args) => {
    try { return await action(...args); }
    catch (error) { console.error(`CLAWBOT_DASHBOARD_REHEARSAL_STEP:${name}:${error.message}`); throw error; }
  }]));
  assert.equal((await switchDashboard(diagnosed)).status, 'CLAWBOT_DASHBOARD_SWITCHED');
  assert.deepEqual(records, ['started', 'completed']); assert.ok(!existsSync(previous.plist));
  await next.stop(); next.remove(); await restore(); await verify(previous, 'old'); records.length = 0;
  actions.verifyNext = async () => { await verify(next, 'new'); throw Error('deliberate-readiness-failure'); };
  assert.equal((await switchDashboard(actions)).status, 'CLAWBOT_DASHBOARD_PREVIOUS_RESTORED');
  assert.deepEqual(records, ['started', 'rolled-back']); assert.ok(!existsSync(next.plist));
  // Simulate a refusal before retirement while the previous listener is intact.
  actions.retirePrevious = () => { throw Error('deliberate-retirement-failure'); }; records.length = 0;
  assert.equal((await switchDashboard(actions)).status, 'CLAWBOT_DASHBOARD_PREVIOUS_RESTORED');
  assert.deepEqual(records, ['started', 'rolled-back']);
  const input = join(folder, 'child-jobs.json');
  writeFileSync(input, JSON.stringify(jobs.map(job => ({ bytes: job.bytes.toString('base64') }))), { flag: 'wx', mode: 0o400 });
  const child = join(folder, 'interrupted-switch.mjs');
  writeFileSync(child, `import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { dashboardJob } from ${JSON.stringify(new URL('./dashboard-job.mjs', import.meta.url).href)};
import { waitForOperationLock } from ${JSON.stringify(new URL('./operation-lock.mjs', import.meta.url).href)};
const jobs = JSON.parse(readFileSync(${JSON.stringify(input)})).map(row => {
  const bytes=Buffer.from(row.bytes,'base64');
  const r=spawnSync('/usr/bin/plutil',['-convert','json','-o','-','--','-'],{input:bytes,encoding:'utf8'});
  assert.equal(r.status,0); return dashboardJob(JSON.parse(r.stdout),bytes);
});
const release=await waitForOperationLock('dashboard-rehearsal',{directory:${JSON.stringify(join(folder, 'operations'))}});
await jobs[0].stop(); jobs[0].remove(); jobs[1].write(); jobs[1].start();
release(); process.kill(process.pid,'SIGKILL');
`, { flag: 'wx', mode: 0o400 });
  const exited = await new Promise((yes, no) => {
    const p = spawn(process.execPath, [child], { stdio: 'ignore' });
    const timer = setTimeout(() => { p.kill('SIGKILL'); no(Error('rehearsal child timeout')); }, 30000);
    p.once('error', error => { clearTimeout(timer); no(error); });
    p.once('exit', (code, signal) => { clearTimeout(timer); yes({ code, signal }); });
  });
  assert.deepEqual(exited, { code: null, signal: 'SIGKILL' }); await verify(next, 'new');
  records.length = 0;
  const recovered = await restoreDashboardSwitch({ ...actions,
    preflight: async () => { await verify(next, 'new'); await lock(); },
  });
  assert.equal(recovered.status, 'CLAWBOT_INTERRUPTED_DASHBOARD_PREVIOUS_RESTORED');
  assert.deepEqual(records, ['started', 'restored']); await verify(previous, 'old'); assert.ok(!existsSync(next.plist));
  console.log('CLAWBOT_REAL_DASHBOARD_SIGKILL_RECOVERY_VERIFIED');
  console.log('CLAWBOT_REAL_DASHBOARD_SWITCH_FAILURE_AND_INTACT_PREVIOUS_RECOVERY_VERIFIED');
} finally {
  try {
    for (const job of [...jobs].reverse()) { await job.stop(); job.remove(); }
    unlock?.(); unlock = undefined; rmSync(folder, { recursive: true });
  } finally { unlock?.(); }
}
