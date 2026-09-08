import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { managedRuntimeSpec, managedCompose } from './managed-runtime-spec.mjs';
import { HOST_FILES, readManagedHostRelease } from './managed-host-release.mjs';
import { waitForOperationLock } from './operation-lock.mjs';

// This command only prepares an inactive, immutable host release. It neither
// creates production data volumes nor writes the separate enable gate.
const [releaseDirectory, cutoverId, sourceSnapshotSha256, importManifestSha256, generationArg, recoveryManifestArg] = process.argv.slice(2);
if (!releaseDirectory || !cutoverId || !sourceSnapshotSha256 || !importManifestSha256) throw new Error('Usage: prepare-production-host.mjs <release-directory> <cutover-id> <source-snapshot-sha256> <import-manifest-sha256> [recovery-generation-uuid source-backup-manifest-sha256]');
const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceCommit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(execFileSync('/usr/bin/git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '', 'Commit this host source first');
const original = JSON.parse(readFileSync(join(resolve(releaseDirectory), 'release.json')));
assert.equal(original.project, 'clawbot-production'); assert.equal(original.sourceCommit, sourceCommit, 'Rebuild from the same host/runtime source');
const target = { profile: 'production', project: 'clawbot-production', runtimeImage: original.images.runtime,
  guardImage: original.images.guard, sourceCommit, cutoverId, sourceSnapshotSha256, importManifestSha256,
  volumeGeneration: generationArg ?? null, recoverySourceManifestSha256: recoveryManifestArg ?? null };
const spec = managedRuntimeSpec(target), unlock = await waitForOperationLock('production-host-preparation');
try {
  const base = join(homedir(), 'Library', 'Application Support', 'Clawbot', 'production-host-releases');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  assert.equal(realpathSync(base), base); assert.ok(!(lstatSync(base).mode & 0o077));
  const directory = join(base, `${sourceCommit}-${cutoverId}${spec.volumeGeneration ? `-recovery-${spec.volumeGeneration}` : ''}`); assert.ok(!existsSync(directory)); mkdirSync(directory, { mode: 0o700 });
  const files = {};
  for (const name of [...HOST_FILES, 'compose.json']) {
    const contents = name === 'compose.json' ? Buffer.from(JSON.stringify(managedCompose(spec))) : readFileSync(new URL(name, import.meta.url));
    writeFileSync(join(directory, name), contents, { flag: 'wx', mode: 0o400 });
    files[name] = createHash('sha256').update(contents).digest('hex');
  }
  writeFileSync(join(directory, 'host-release.json'), JSON.stringify({ version: 1, target, files }), { flag: 'wx', mode: 0o400 });
  readManagedHostRelease(directory);
  const xml = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>com.clawbot.mac-production-host</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(directory, 'production-host.mjs'))}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`;
  writeFileSync(join(directory, 'com.clawbot.mac-production-host.plist'), plist, { flag: 'wx', mode: 0o400 });
  console.log(JSON.stringify({ status: 'CLAWBOT_PRODUCTION_HOST_PREPARED_DISABLED', directory, sourceCommit }));
} finally { unlock(); }
