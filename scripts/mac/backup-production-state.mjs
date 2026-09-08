import assert from 'node:assert/strict';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readManagedHostRelease } from './managed-host-release.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { operationsRoot, waitForOperationLock } from './operation-lock.mjs';
import { backupNineVolumes } from './backup-nine-volumes.mjs';
import { fileURLToPath } from 'node:url';

export async function backupProductionState({ spec, driver, base, operations = operationsRoot, backup = backupNineVolumes }) {
  return await backup({ project: spec.project, image: spec.services.openclaw.image, volumeGeneration: spec.volumeGeneration ?? null,
    backupRoot: join(base, 'production-backups'), keyRoot: join(base, 'production-backup-keys'),
    assertQuiescent: async () => {
      const path = join(operations, 'production-maintenance'), stat = lstatSync(path);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077) && stat.size < 4096);
      const marker = JSON.parse(readFileSync(path));
      assert.equal(marker.project, spec.project); assert.equal(marker.sourceCommit, spec.sourceCommit);
      assert.equal(marker.cutoverId, spec.cutoverId); assert.equal(marker.importManifestSha256, spec.importManifestSha256);
      assert.equal(marker.volumeGeneration ?? null, spec.volumeGeneration ?? null);
      const view = await driver.inspect();
      assert.ok(view.available && view.identityValid && Object.values(view.running).every((running) => !running));
      assert.ok(await driver.validateInputs());
    } });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: backup-production-state.mjs <immutable-host-directory>');
  const directory = resolve(process.argv[2]), base = join(homedir(), 'Library', 'Application Support', 'Clawbot');
  assert.ok(directory.startsWith(join(base, 'production-host-releases') + '/') && realpathSync(directory) === directory);
  const { spec } = readManagedHostRelease(directory), driver = managedDockerDriver(spec, join(directory, 'compose.json'));
  const unlock = await waitForOperationLock('production-backup');
  try { console.log(JSON.stringify(await backupProductionState({ spec, driver, base }))); }
  // Maintenance deliberately remains in effect even after success. A backup
  // failure cannot become an implicit command to restart ingestion.
  finally { unlock(); }
}
