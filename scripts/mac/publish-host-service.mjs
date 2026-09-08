import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, realpathSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { acquireOperationLock } from './operation-lock.mjs';
import { verifyTestHost } from './verify-test-host.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const env = { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}` };
function run(file, args) {
  const result = spawnSync(file, args, { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('CLAWBOT_HOST_PUBLICATION_FAILED');
  return result.stdout;
}
const releaseLock = acquireOperationLock('host-publication');
try {
  assert.equal(run('/usr/bin/git', ['status', '--porcelain']).trim(), '', 'Commit reviewed source before publication');
  const sourceCommit = run('/usr/bin/git', ['rev-parse', 'HEAD']).trim(); assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  verifyTestHost();
  const runtimeImage = JSON.parse(run(docker, ['image', 'inspect', 'clawbot-openclaw-test:p1']))[0].Id;
  const compose = JSON.parse(run(docker, ['compose', '-f', 'deploy/docker/compose.test.yml', 'config', '--format', 'json']));
  for (const service of Object.values(compose.services)) {
    delete service.build;
    if (service.image === 'clawbot-openclaw-test:p1') service.image = runtimeImage;
  }
  // No setup/login helpers are auto-started by the host service.
  compose.services = { origin: compose.services.origin, openclaw: compose.services.openclaw };
  const base = join(homedir(), 'Library', 'Application Support', 'Clawbot', 'host-releases');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  assert.equal(realpathSync(base), base); assert.ok(!(lstatSync(base).mode & 0o077));
  const directory = join(base, sourceCommit); assert.ok(!existsSync(directory), 'Release already exists');
  mkdirSync(directory, { mode: 0o700 });
  const files = {};
  function put(path, contents) {
    const target = join(directory, path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, contents, { flag: 'wx', mode: 0o400 });
    files[path] = createHash('sha256').update(contents).digest('hex');
  }
  for (const path of ['scripts/mac/host-service.mjs', 'scripts/mac/status-server.mjs', 'scripts/mac/operation-lock.mjs',
    'scripts/mac/verify-test-host.mjs', 'scripts/mac/observation.mjs', 'scripts/mac/model-authorization.mjs',
    'scripts/mac/model-authorization-inspection.mjs', 'scripts/mac/ledger-authorization-inspection.mjs',
    'scripts/mac/weixin-authorization-inspection.mjs', 'deploy/docker/weixin-authorization.mjs',
    'deploy/docker/ledger-authorization.mjs', 'deploy/dashboard/index.html', 'deploy/dashboard/dashboard.js', 'deploy/dashboard/dashboard.css']) {
    put(path, readFileSync(join(root, path)));
  }
  put('deploy/docker/compose.test.yml', JSON.stringify(compose, null, 2));
  writeFileSync(join(directory, 'release-runtime.json'), JSON.stringify({ version: 1, project: 'clawbot-test', sourceCommit,
    runtimeImage, node: process.execPath, files }, null, 2), { flag: 'wx', mode: 0o400 });
  const launchDirectory = join(homedir(), 'Library', 'LaunchAgents'); mkdirSync(launchDirectory, { recursive: true });
  const prepareOnly = process.argv.includes('--prepare');
  const plist = prepareOnly ? join(directory, 'host.plist') : join(launchDirectory, 'com.clawbot.mac-test-host.plist');
  assert.ok(!existsSync(plist), 'Existing host job must be inspected before replacement');
  const xml = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  // No unbounded log files. State is a bounded atomic JSON record on the host;
  // Docker business logs have their own fixed rotation budget.
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.clawbot.mac-test-host</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(directory, 'scripts/mac/host-service.mjs'))}</string></array><key>WorkingDirectory</key><string>${xml(directory)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>\n`, { flag: 'wx', mode: 0o600 });
  run('/usr/bin/plutil', ['-lint', plist]);
  console.log(JSON.stringify({ status: 'CLAWBOT_HOST_RELEASE_PREPARED', directory, plist, sourceCommit, runtimeImage }));
  // Explicit activation follows a review of the prepared immutable artifact.
} finally { releaseLock(); }
