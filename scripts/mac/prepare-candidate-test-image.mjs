import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, lstatSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyImageSourceFiles } from './production-image-inventory.mjs';

// Build the existing isolated-test target from the exact candidate commit.
// Production keeps its production-only manifest and cannot accept this profile.
const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const env = { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}` };
let temporary, checkout, registered = false, stage = 'preflight';
try {
  assert.equal(process.argv.length, 3);
  const directory = resolve(process.argv[2]);
  assert.ok(directory.startsWith(join(homedir(), 'Library/Application Support/Clawbot/production-releases') + '/')
    && realpathSync(directory) === directory);
  const path = join(directory, 'release.json'), stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o222) && stat.size < 1048576);
  const release = JSON.parse(readFileSync(path));
  assert.equal(release.project, 'clawbot-production'); assert.equal(release.activated, false);
  assert.match(release.sourceCommit, /^[a-f0-9]{40}$/);
  const output = join(directory, 'test-image.json'); assert.ok(!existsSync(output));
  function run(file, args, cwd = root, timeout = 60000) {
    const r = spawnSync(file, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(r.status, 0, 'CLAWBOT_CANDIDATE_TEST_IMAGE_COMMAND_FAILED'); return r.stdout.trim();
  }
  verifyImageSourceFiles(release.images.runtime, release.files, 'runtime');
  temporary = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-candidate-source-')));
  checkout = join(temporary, 'checkout'); stage = 'source-checkout';
  run('/usr/bin/git', ['worktree', 'add', '--detach', checkout, release.sourceCommit]); registered = true;
  assert.equal(run('/usr/bin/git', ['status', '--porcelain'], checkout), '');
  assert.equal(run('/usr/bin/git', ['rev-parse', 'HEAD'], checkout), release.sourceCommit);
  const tag = `clawbot-candidate-test:${release.sourceCommit}`;
  assert.equal(run(docker, ['image', 'ls', '--format', '{{.ID}}', tag]), '');
  stage = 'build';
  run(docker, ['build', '--platform', 'linux/arm64', '-f', 'deploy/docker/Dockerfile.openclaw', '--target', 'isolated-test',
    '--label', `org.opencontainers.image.revision=${release.sourceCommit}`, '--label', 'clawbot.purpose=candidate-validation', '-t', tag, '.'], checkout, 600000);
  const image = JSON.parse(run(docker, ['image', 'inspect', tag]))[0];
  assert.equal(image.Architecture, 'arm64'); assert.equal(image.Config.Labels['org.opencontainers.image.revision'], release.sourceCommit);
  assert.equal(image.Config.Labels['clawbot.purpose'], 'candidate-validation');
  stage = 'content';
  const checked = verifyImageSourceFiles(image.Id, release.files, 'runtime');
  assert.equal(run('/usr/bin/git', ['status', '--porcelain'], checkout), '');
  const evidence = { version: 1, purpose: 'candidate-validation', sourceCommit: release.sourceCommit,
    productionRuntimeImage: release.images.runtime, image: image.Id, tag, sourceFiles: checked.files,
    profile: 'isolated-test', productionServiceAcceptance: false, createdAt: new Date().toISOString() };
  writeFileSync(output, JSON.stringify(evidence), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'CLAWBOT_SAME_SOURCE_CANDIDATE_TEST_IMAGE_PREPARED', ...evidence }));
} catch { console.error(`CLAWBOT_CANDIDATE_TEST_IMAGE_FAILED:${stage}`); process.exitCode = 1; }
finally {
  if (registered) {
    const r = spawnSync('/usr/bin/git', ['worktree', 'remove', checkout], { cwd: root, encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) { console.error('CLAWBOT_CANDIDATE_CHECKOUT_CLEANUP_REQUIRED'); process.exitCode = 1; }
    else registered = false;
  }
  if (temporary && !registered) rmSync(temporary, { recursive: true });
}
