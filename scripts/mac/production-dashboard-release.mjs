import assert from 'node:assert/strict';
import { readFileSync, lstatSync, realpathSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readManagedHostRelease } from './managed-host-release.mjs';
export const PRODUCTION_DASHBOARD_FILES = Object.freeze([
  'scripts/mac/production-dashboard-release.mjs', 'scripts/mac/production-status-server.mjs', 'scripts/mac/status-http.mjs',
  'scripts/mac/production-status.mjs', 'scripts/mac/production-status-adapter.mjs', 'scripts/mac/background-authorization-checks.mjs',
  'scripts/mac/managed-host-release.mjs', 'scripts/mac/managed-runtime-spec.mjs', 'scripts/mac/managed-docker-driver.mjs',
  'scripts/mac/runtime-controller.mjs', 'scripts/mac/operation-lock.mjs', 'scripts/mac/managed-host-job.mjs',
  'scripts/mac/model-authorization.mjs', 'scripts/mac/model-authorization-inspection.mjs',
  'scripts/mac/ledger-authorization-inspection.mjs', 'scripts/mac/weixin-authorization-inspection.mjs',
  'scripts/mac/tunnel-authorization-inspection.mjs', 'deploy/docker/ledger-authorization.mjs', 'deploy/docker/weixin-authorization.mjs',
  'deploy/dashboard/production.html', 'deploy/dashboard/production.js', 'deploy/dashboard/dashboard.css',
]);
export function readProductionDashboardRelease(directory) {
  const stat = lstatSync(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077) && realpathSync(directory) === directory);
  function read(name) {
    const path = join(directory, name), s = lstatSync(path);
    assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === process.getuid()
      && !(s.mode & 0o222) && s.size < 2 * 1024 * 1024 && realpathSync(path) === path);
    return readFileSync(path);
  }
  const release = JSON.parse(read('dashboard-release.json'));
  assert.deepEqual(Object.keys(release).sort(), ['version', 'purpose', 'sourceCommit', 'hostDirectory', 'target', 'files', 'taskSha256'].sort());
  assert.equal(release.version, 1); assert.equal(release.purpose, 'production-dashboard');
  assert.match(release.sourceCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(Object.keys(release.files ?? {}).sort(), [...PRODUCTION_DASHBOARD_FILES].sort());
  for (const [name, hash] of Object.entries(release.files)) assert.equal(createHash('sha256').update(read(name)).digest('hex'), hash);
  assert.equal(createHash('sha256').update(read('dashboard.plist')).digest('hex'), release.taskSha256);
  const base = join(homedir(), 'Library/Application Support/Clawbot/production-host-releases');
  assert.ok(typeof release.hostDirectory === 'string' && release.hostDirectory.startsWith(base + '/') && realpathSync(release.hostDirectory) === release.hostDirectory);
  const { spec } = readManagedHostRelease(release.hostDirectory); assert.deepEqual(release.target, spec);
  return { release, spec };
}

export function writeProductionDashboardRelease(directory, hostDirectory, sourceCommit) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/); assert.ok(!existsSync(directory));
  const { spec } = readManagedHostRelease(hostDirectory);
  mkdirSync(directory, { mode: 0o700 }); assert.equal(realpathSync(directory), directory);
  const root = fileURLToPath(new URL('../../', import.meta.url)), files = {};
  for (const name of PRODUCTION_DASHBOARD_FILES) {
    const source = join(root, name), stat = lstatSync(source);
    assert.ok(stat.isFile() && !stat.isSymbolicLink()); const bytes = readFileSync(source);
    mkdirSync(dirname(join(directory, name)), { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, name), bytes, { flag: 'wx', mode: 0o400 });
    files[name] = createHash('sha256').update(bytes).digest('hex');
  }
  const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const task = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>com.clawbot.mac-production-dashboard</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(directory, 'scripts/mac/production-status-server.mjs'))}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`;
  writeFileSync(join(directory, 'dashboard.plist'), task, { flag: 'wx', mode: 0o400 });
  writeFileSync(join(directory, 'dashboard-release.json'), JSON.stringify({ version: 1, purpose: 'production-dashboard', sourceCommit,
    hostDirectory, target: spec, files, taskSha256: createHash('sha256').update(task).digest('hex') }), { flag: 'wx', mode: 0o400 });
  return readProductionDashboardRelease(directory);
}
