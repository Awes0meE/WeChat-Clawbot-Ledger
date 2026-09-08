import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync, existsSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readManagedHostRelease, activationMatches } from './managed-host-release.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { enterMaintenance, leaveMaintenance } from './maintenance-operation.mjs';
import { operationsRoot, waitForOperationLock } from './operation-lock.mjs';

const [action, directoryArg] = process.argv.slice(2);
if (!['enter', 'resume'].includes(action) || !directoryArg) throw new Error('Usage: production-maintenance.mjs <enter|resume> <immutable-host-directory>');
const directory = resolve(directoryArg), base = join(homedir(), 'Library', 'Application Support', 'Clawbot', 'production-host-releases');
assert.ok(directory.startsWith(base + '/') && realpathSync(directory) === directory);
const { spec } = readManagedHostRelease(directory), driver = managedDockerDriver(spec, join(directory, 'compose.json'));
const unlock = await waitForOperationLock('production-maintenance'), path = join(operationsRoot, 'production-maintenance');
const identity = { version: 1, project: spec.project, sourceCommit: spec.sourceCommit, cutoverId: spec.cutoverId,
  importManifestSha256: spec.importManifestSha256, volumeGeneration: spec.volumeGeneration ?? null };
try {
  if (action === 'enter') {
    assert.ok(!existsSync(path), 'A maintenance marker already exists; inspect it before repeating');
    await enterMaintenance(driver, () => writeFileSync(path, JSON.stringify({ ...identity, nonce: randomUUID(),
      enteredAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }));
    console.log('CLAWBOT_PRODUCTION_MAINTENANCE_STOPPED');
  } else {
    const stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077) && stat.size < 4096);
    const original = readFileSync(path), marker = JSON.parse(original);
    for (const [key, value] of Object.entries(identity)) assert.equal(key === 'volumeGeneration' ? marker[key] ?? null : marker[key], value, 'Maintenance belongs to another release');
    const gatePath = join(operationsRoot, 'production-enabled.json'), gateStat = lstatSync(gatePath);
    assert.ok(gateStat.isFile() && !gateStat.isSymbolicLink() && !(gateStat.mode & 0o077) && gateStat.size < 4096);
    assert.ok(activationMatches(JSON.parse(readFileSync(gatePath)), spec), 'Enable gate does not match this release');
    await leaveMaintenance(driver, { storageFault: existsSync(join(operationsRoot, 'production-storage-fault.json')),
      remove: () => { assert.deepEqual(readFileSync(path), original); unlinkSync(path); } });
    console.log('CLAWBOT_PRODUCTION_MAINTENANCE_RELEASED_FOR_HOST');
  }
} finally { unlock(); }
