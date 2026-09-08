import assert from 'node:assert/strict';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
const base = join(homedir(), 'Library/Application Support/Clawbot/host-releases');
export function readTestHostRelease(id) {
  assert.match(id, /^[a-f0-9]{40}$/);
  const directory = join(base, id); assert.equal(realpathSync(directory), directory);
  const read = (path) => {
    const target = join(directory, path), stat = lstatSync(target);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && realpathSync(target) === target && !(stat.mode & 0o222) && stat.size < 2 * 1024 * 1024);
    return readFileSync(target);
  };
  const release = JSON.parse(read('release-runtime.json'));
  assert.equal(release.version, 1); assert.equal(release.project, 'clawbot-test'); assert.equal(release.sourceCommit, id);
  assert.equal(release.node, process.execPath); assert.match(release.runtimeImage, /^sha256:[a-f0-9]{64}$/);
  for (const required of ['scripts/mac/host-service.mjs', 'scripts/mac/status-server.mjs', 'scripts/mac/operation-lock.mjs',
    'scripts/mac/verify-test-host.mjs', 'deploy/dashboard/index.html', 'deploy/dashboard/dashboard.js',
    'deploy/dashboard/dashboard.css', 'deploy/docker/compose.test.yml']) assert.ok(release.files[required]);
  for (const [path, hash] of Object.entries(release.files)) {
    assert.match(path, /^(scripts\/mac\/[a-z-]+\.mjs|deploy\/dashboard\/[a-z.-]+|deploy\/docker\/(compose\.test\.yml|ledger-authorization\.mjs|weixin-authorization\.mjs))$/);
    assert.equal(createHash('sha256').update(read(path)).digest('hex'), hash);
  }
  return { directory, release };
}
