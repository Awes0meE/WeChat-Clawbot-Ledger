import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeProductionDashboardRelease } from './production-dashboard-release.mjs';
import { waitForOperationLock } from './operation-lock.mjs';
try {
  assert.equal(process.argv.length, 3);
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const git = args => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(git(['status', '--porcelain']), '', 'Commit the dashboard source before preparation');
  const sourceCommit = git(['rev-parse', 'HEAD']), hostDirectory = resolve(process.argv[2]);
  assert.ok(hostDirectory.startsWith(join(homedir(), 'Library/Application Support/Clawbot/production-host-releases') + '/'));
  const base = join(homedir(), 'Library/Application Support/Clawbot/production-dashboard-releases');
  const unlock = await waitForOperationLock('production-dashboard-preparation');
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    assert.ok(realpathSync(base) === base && lstatSync(base).uid === process.getuid() && !(lstatSync(base).mode & 0o077));
    const directory = join(base, `${sourceCommit}-${createHash('sha256').update(hostDirectory).digest('hex').slice(0, 16)}`);
    writeProductionDashboardRelease(directory, hostDirectory, sourceCommit);
    assert.equal(git(['status', '--porcelain']), ''); assert.equal(git(['rev-parse', 'HEAD']), sourceCommit);
    console.log(JSON.stringify({ status: 'CLAWBOT_PRODUCTION_DASHBOARD_PREPARED_NOT_INSTALLED', directory, sourceCommit }));
  } finally { unlock(); }
} catch { console.error('CLAWBOT_PRODUCTION_DASHBOARD_PREPARATION_REFUSED'); process.exitCode = 1; }
