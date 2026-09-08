import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { HOST_FILES, readManagedHostRelease, activationMatches } from '../../../scripts/mac/managed-host-release.mjs';
import { managedRuntimeSpec, managedCompose } from '../../../scripts/mac/managed-runtime-spec.mjs';
test('Host release rejects incomplete files, writable content, tampering and non-matching cutover activation', { skip: process.platform === 'win32' }, () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-release-')));
  try {
    const target = { profile: 'production', project: 'clawbot-production', runtimeImage: `sha256:${'a'.repeat(64)}`,
      guardImage: `sha256:${'b'.repeat(64)}`, sourceCommit: 'c'.repeat(40), sourceSnapshotSha256: 'd'.repeat(64), importManifestSha256: 'e'.repeat(64),
      cutoverId: '11111111-2222-3333-4444-555555555555' }, files = {};
    for (const name of [...HOST_FILES, 'compose.json']) {
      const data = name === 'compose.json' ? JSON.stringify(managedCompose(managedRuntimeSpec(target))) : '// synthetic fixture';
      writeFileSync(join(directory, name), data, { mode: 0o400 }); files[name] = createHash('sha256').update(data).digest('hex');
    }
    writeFileSync(join(directory, 'host-release.json'), JSON.stringify({ version: 1, target, files }), { mode: 0o400 });
    assert.equal(readManagedHostRelease(directory).spec.sourceCommit, target.sourceCommit);
    const gate = { version: 1, project: target.project, enabled: true, sourceCommit: target.sourceCommit,
      cutoverId: target.cutoverId, sourceSnapshotSha256: target.sourceSnapshotSha256, importManifestSha256: target.importManifestSha256 };
    assert.ok(activationMatches(gate, target));
    assert.equal(activationMatches({ ...gate, cutoverId: 'wrong' }, target), false);
    assert.equal(activationMatches({ ...gate, enabled: false }, target), false);
    chmodSync(join(directory, HOST_FILES[0]), 0o600);
    assert.throws(() => readManagedHostRelease(directory), /RELEASE_FILE/);
    writeFileSync(join(directory, HOST_FILES[0]), 'changed'); chmodSync(join(directory, HOST_FILES[0]), 0o400);
    assert.throws(() => readManagedHostRelease(directory), /RELEASE_HASH/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
