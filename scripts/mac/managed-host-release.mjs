import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { managedRuntimeSpec, managedCompose } from './managed-runtime-spec.mjs';
export const HOST_FILES = Object.freeze(['production-host.mjs', 'managed-host-release.mjs', 'managed-runtime-spec.mjs',
  'managed-docker-driver.mjs', 'runtime-controller.mjs', 'operation-lock.mjs']);
export function readManagedHostRelease(directory) {
  if (realpathSync(directory) !== directory) throw new Error('CLAWBOT_HOST_RELEASE_PATH');
  function read(name) {
    const path = join(directory, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222) || stat.size > 2 * 1024 * 1024) throw new Error('CLAWBOT_HOST_RELEASE_FILE');
    return readFileSync(path);
  }
  const release = JSON.parse(read('host-release.json'));
  if (release.version !== 1 || release.target?.profile !== 'production') throw new Error('CLAWBOT_HOST_RELEASE_PROFILE');
  const spec = managedRuntimeSpec(release.target);
  if (JSON.stringify(Object.keys(release.files ?? {}).sort()) !== JSON.stringify([...HOST_FILES, 'compose.json'].sort())) throw new Error('CLAWBOT_HOST_RELEASE_INCOMPLETE');
  for (const [path, expected] of Object.entries(release.files)) {
    if (createHash('sha256').update(read(path)).digest('hex') !== expected) throw new Error('CLAWBOT_HOST_RELEASE_HASH');
  }
  if (JSON.stringify(JSON.parse(read('compose.json'))) !== JSON.stringify(managedCompose(spec))) throw new Error('CLAWBOT_HOST_COMPOSE_POLICY');
  return { release, spec };
}
export function activationMatches(gate, spec) {
  return gate?.version === 1 && gate.project === 'clawbot-production' && gate.enabled === true
    && gate.sourceCommit === spec.sourceCommit && gate.cutoverId === spec.cutoverId
    && gate.sourceSnapshotSha256 === spec.sourceSnapshotSha256 && gate.importManifestSha256 === spec.importManifestSha256
    && (gate.volumeGeneration ?? null) === (spec.volumeGeneration ?? null)
    && (gate.recoverySourceManifestSha256 ?? null) === (spec.recoverySourceManifestSha256 ?? null);
}
