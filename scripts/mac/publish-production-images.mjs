import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyImageSourceFiles } from './production-image-inventory.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const environment = { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}` };
function run(file, args, env = environment, timeout = 60000) {
  const result = spawnSync(file, args, { cwd: root, env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('CLAWBOT_IMAGE_PUBLICATION_FAILED');
  return result.stdout;
}
assert.equal(run('/usr/bin/git', ['status', '--porcelain']).trim(), '', 'Commit reviewed source before publication');
const sourceCommit = run('/usr/bin/git', ['rev-parse', 'HEAD']).trim(); assert.match(sourceCommit, /^[a-f0-9]{40}$/);
const images = {};
for (const [name, file, target] of [['runtime', 'deploy/docker/Dockerfile.openclaw', 'production'], ['guard', 'deploy/guard/Dockerfile']]) {
  const tag = `clawbot-${name}-production:${sourceCommit}`;
  run(docker, ['build', '--platform', 'linux/arm64', '-f', file, ...(target ? ['--target', target] : []),
    '--build-arg', `SOURCE_COMMIT=${sourceCommit}`, '--label', `org.opencontainers.image.revision=${sourceCommit}`, '-t', tag, '.'], environment, 600000);
  const image = JSON.parse(run(docker, ['image', 'inspect', tag]))[0];
  assert.equal(image.Architecture, 'arm64'); assert.equal(image.Config.Labels['org.opencontainers.image.revision'], sourceCommit);
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/); images[name] = image.Id;
  console.log(`CLAWBOT_PRODUCTION_IMAGE_BUILT:${name}`);
}
const env = { ...environment, CLAWBOT_PRODUCTION_RUNTIME_IMAGE: images.runtime, CLAWBOT_GUARD_IMAGE: images.guard };
const config = JSON.parse(run(docker, ['compose', '-f', 'deploy/docker/compose.production.yml', 'config', '--format', 'json'], env));
assert.equal(config.name, 'clawbot-production');
for (const service of Object.values(config.services)) {
  assert.ok(!service.ports?.length && !service.build && service.read_only === true && service.user === '1000:1000');
}
const base = join(homedir(), 'Library', 'Application Support', 'Clawbot', 'production-releases');
mkdirSync(base, { recursive: true, mode: 0o700 });
assert.equal(realpathSync(base), base); assert.ok(!(lstatSync(base).mode & 0o077));
const directory = join(base, sourceCommit); assert.ok(!existsSync(directory));
const compose = JSON.stringify(config, null, 2);
const tracked = run('/usr/bin/git', ['ls-files', '-z']).split('\0').filter(Boolean);
const files = {};
for (const path of tracked.filter((p) => /^(deploy\/|openclaw-plugins\/|openclaw-hooks\/|openclaw-workspace\/|config\/)/.test(p))) {
  const stat = lstatSync(join(root, path)); assert.ok(stat.isFile() && !stat.isSymbolicLink());
  files[path] = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
}
for (const [role,image] of Object.entries(images)) {
  const checked=verifyImageSourceFiles(image,files,role);
  console.log(`CLAWBOT_PRODUCTION_IMAGE_CONTENT_VERIFIED:${role}:${checked.files}`);
}
assert.equal(run('/usr/bin/git', ['status', '--porcelain']).trim(), '', 'Source changed during build');
assert.equal(run('/usr/bin/git', ['rev-parse', 'HEAD']).trim(), sourceCommit);
mkdirSync(directory, { mode: 0o700 });
writeFileSync(join(directory, 'compose.production.json'), compose, { flag: 'wx', mode: 0o400 });
writeFileSync(join(directory, 'release.json'), JSON.stringify({ version: 1, project: 'clawbot-production', sourceCommit,
  createdAt: new Date().toISOString(), architecture: 'arm64', images, files,
  composeSha256: createHash('sha256').update(compose).digest('hex'), activated: false }, null, 2), { flag: 'wx', mode: 0o400 });
console.log(JSON.stringify({ status: 'CLAWBOT_PRODUCTION_RELEASE_PREPARED_NOT_ACTIVATED', directory, sourceCommit, images }));
