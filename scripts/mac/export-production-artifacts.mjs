import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, readdirSync, statfsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { waitForOperationLock } from './operation-lock.mjs';
import { fileSha256 } from '../../deploy/docker/migration-files.mjs';
import { assertBackupBudget } from './backup-budget.mjs';

// Code/runtime recovery material only: Docker volumes, accounts, OAuth and
// backup encryption keys are never included. Images are saved by content ID
// with no repository tags, so the load verification cannot replace tag names.
if (!process.argv[2]) throw Error('Usage: export-production-artifacts.mjs <production-release-directory>');
const root = fileURLToPath(new URL('../../', import.meta.url)), directory = resolve(process.argv[2]);
const base = join(homedir(), 'Library', 'Application Support', 'Clawbot');
assert.ok(directory.startsWith(join(base, 'production-releases') + '/') && realpathSync(directory) === directory);
const exec = promisify(execFile), docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
async function run(file, args, timeout = 60000) {
  try { return (await exec(file, args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 })).stdout.trim(); }
  catch { throw Error('CLAWBOT_ARTIFACT_EXPORT_STEP_FAILED'); }
}
const unlock = await waitForOperationLock('production-artifact-export');
try {
  assert.equal(await run('/usr/bin/git', ['status', '--porcelain']), '', 'Commit the exporter source before use');
  const releaseText = readFileSync(join(directory, 'release.json')), release = JSON.parse(releaseText);
  const composeText = readFileSync(join(directory, 'compose.production.json')), compose = JSON.parse(composeText);
  assert.deepEqual(Object.keys(release).sort(), ['version', 'project', 'sourceCommit', 'createdAt', 'architecture', 'images', 'files', 'composeSha256', 'activated'].sort());
  assert.deepEqual(Object.keys(release.images).sort(), ['guard', 'runtime']);
  assert.equal(release.project, 'clawbot-production'); assert.equal(release.sourceCommit, await run('/usr/bin/git', ['rev-parse', 'HEAD']));
  assert.equal(createHash('sha256').update(composeText).digest('hex'), release.composeSha256);
  const references = { ...release.images, origin: compose.services.origin.image }, images = {}; let estimatedBytes = 0;
  for (const [role, reference] of Object.entries(references)) {
    const image = JSON.parse(await run(docker, ['image', 'inspect', reference]))[0];
    assert.equal(image.Architecture, 'arm64');
    if (role !== 'origin') {
      assert.equal(image.Id, reference); assert.equal(image.Config.Labels?.['org.opencontainers.image.revision'], release.sourceCommit);
      const marker = await run(docker, ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000',
        '--entrypoint', 'node', image.Id, '-e', 'console.log(JSON.parse(require("node:fs").readFileSync("/etc/clawbot-release.json")).sourceCommit)']);
      assert.equal(marker, release.sourceCommit);
    } else assert.equal(reference, 'mayswind/ezbookkeeping@sha256:1043c95201f0432cd30328f6feb9a5b57359449400ea54fdf9a0c6138ab4c227');
    images[role] = image.Id; estimatedBytes += image.Size;
  }
  const archiveRoot = join(base, 'image-archives'); mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  assert.equal(realpathSync(archiveRoot), archiveRoot); assert.ok(!(lstatSync(archiveRoot).mode & 0o077));
  function used(path) { const stat = lstatSync(path); assert.ok(!stat.isSymbolicLink());
    return stat.isDirectory() ? readdirSync(path).reduce((n, name) => n + used(join(path, name)), 0) : stat.size; }
  const disk = statfsSync(archiveRoot);
  assertBackupBudget({ freeBytes: disk.bavail * disk.bsize, existingBytes: used(archiveRoot), sourceBytes: estimatedBytes, entries: 10 });
  const target = join(archiveRoot, `${release.sourceCommit}-${randomUUID()}`); mkdirSync(target, { mode: 0o700 });
  const before = await run(docker, ['ps', '-a', '--no-trunc', '-q']);
  const imageArchive = join(target, 'images.tar'), bundle = join(target, 'source.bundle');
  await run(docker, ['image', 'save', '-o', imageArchive, ...Object.values(images)], 300000);
  const imageManifest = JSON.parse(await run('/usr/bin/tar', ['-xOf', imageArchive, 'manifest.json'], 300000));
  assert.ok(imageManifest.every((item) => !item.RepoTags?.length), 'Image archive unexpectedly includes tag names');
  await run('/usr/bin/git', ['bundle', 'create', bundle, 'HEAD'], 120000);
  chmodSync(imageArchive, 0o600); chmodSync(bundle, 0o600);
  assert.equal(await run('/usr/bin/git', ['bundle', 'list-heads', bundle]), `${release.sourceCommit} HEAD`);
  await run('/usr/bin/git', ['bundle', 'verify', bundle]);
  await run(docker, ['image', 'load', '-i', imageArchive], 300000);
  for (const id of Object.values(images)) assert.equal(JSON.parse(await run(docker, ['image', 'inspect', id]))[0].Id, id);
  assert.equal(await run(docker, ['ps', '-a', '--no-trunc', '-q']), before, 'Image check changed container inventory');
  writeFileSync(join(target, 'release.json'), releaseText, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(target, 'compose.production.json'), composeText, { flag: 'wx', mode: 0o600 });
  const hashes = {};
  for (const name of ['images.tar', 'source.bundle', 'release.json', 'compose.production.json']) hashes[name] = await fileSha256(join(target, name));
  const evidence = { status: 'CLAWBOT_PRODUCTION_ARTIFACTS_EXPORTED_AND_RELOADED', sourceCommit: release.sourceCommit,
    checkedAt: new Date().toISOString(), images, hashes, credentialsIncluded: false, containersStarted: false };
  writeFileSync(join(target, 'verified.json'), JSON.stringify(evidence), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: evidence.status, directory: target, sourceCommit: release.sourceCommit,
    credentialsIncluded: false, containersStarted: false }));
} finally { unlock(); }
