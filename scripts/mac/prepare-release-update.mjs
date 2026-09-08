import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync, realpathSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readManagedHostRelease } from './managed-host-release.mjs';
import { operationsRoot, waitForOperationLock } from './operation-lock.mjs';
import { releaseUpdateStageTemplate } from './release-update-review.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { stageRecoveryGeneration } from './stage-recovery-generation.mjs';

const [action, currentArg, hostArg, candidateArg, reviewArg] = process.argv.slice(2);
if (!['prepare', 'stage'].includes(action) || !currentArg || !hostArg || !candidateArg || (action === 'stage' && !reviewArg)) {
  throw Error('Usage: prepare-release-update.mjs <prepare|stage> <current-host> <inactive-new-release-host> <private-candidate-record> [private-review]');
}
const host = resolve(hostArg), root = join(homedir(), 'Library/Application Support/Clawbot/production-host-releases');
assert.ok(host.startsWith(root + '/') && realpathSync(host) === host);
const current = resolve(currentArg); assert.ok(current.startsWith(root + '/') && realpathSync(current) === current);
const { spec: before } = readManagedHostRelease(current);
const { spec } = readManagedHostRelease(host); assert.ok(spec.volumeGeneration);
function privateRead(path) {
  const resolved = resolve(path), stat = lstatSync(resolved);
  assert.ok(resolved.startsWith(operationsRoot + '/') && realpathSync(resolved) === resolved && stat.isFile()
    && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077) && stat.size < 65536);
  return readFileSync(resolved);
}
const unlock = await waitForOperationLock('release-update-stage');
try {
  const candidateBytes = privateRead(candidateArg), candidate = JSON.parse(candidateBytes);
  const path = join(operationsRoot, `release-update-review-${spec.volumeGeneration}.json`);
  if (action === 'prepare') {
    writeFileSync(path, JSON.stringify(releaseUpdateStageTemplate(before, spec, candidate), null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ status: 'CLAWBOT_RELEASE_UPDATE_REVIEW_ALL_UNCONFIRMED', path }));
  } else {
    const reviewBytes = privateRead(reviewArg), review = JSON.parse(reviewBytes);
    const result = await stageRecoveryGeneration({ spec, candidate, review, image: spec.services.openclaw.image, reservePath: operationsRoot, releaseUpdateFrom: before });
    assert.ok(await managedDockerDriver(spec, join(host, 'compose.json')).validateInputs(), 'New release production inputs refused');
    assert.deepEqual(privateRead(candidateArg), candidateBytes); assert.deepEqual(privateRead(reviewArg), reviewBytes);
    const records = join(operationsRoot, 'release-update-stages'); mkdirSync(records, { recursive: true, mode: 0o700 });
    const st = lstatSync(records); assert.ok(st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid() && !(st.mode & 0o077) && realpathSync(records) === records);
    writeFileSync(join(records, `${spec.volumeGeneration}.json`), JSON.stringify({ ...result, productionInputsVerified: true, stagedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ status: result.status, volumeGeneration: spec.volumeGeneration, productionActivated: false }));
  }
} catch { console.error('CLAWBOT_RELEASE_UPDATE_STAGE_FAILED_NEW_TARGET_REQUIRES_INSPECTION'); process.exitCode = 1; }
finally { unlock(); }
