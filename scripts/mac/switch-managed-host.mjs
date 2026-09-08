import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync, realpathSync, existsSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readManagedHostRelease, activationMatches } from './managed-host-release.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { managedHostJob, atomicPrivateReplace } from './managed-host-job.mjs';
import { auditManagedState } from './managed-state-audit.mjs';
import { generationSwitchTemplate, switchGenerationInMaintenance, releaseUpdateSwitchTemplate, switchReleaseUpdateInMaintenance } from './generation-switch.mjs';
import { validateReleaseUpdateSelection } from './release-update-review.mjs';
import { decryptArchive } from './backup-crypto.mjs';
import { MIGRATION_ROLES } from '../../deploy/docker/migration-format.mjs';
import { operationsRoot, waitForOperationLock } from './operation-lock.mjs';

export async function runManagedHostSwitch(operation, args = process.argv.slice(2)) {
  assert.ok(['recovery', 'release-update'].includes(operation));
  const updating = operation === 'release-update';
  const [action, oldArg, newArg, backupArg, stageArg, reviewArg] = args;
  if (!['prepare', 'switch'].includes(action) || !oldArg || !newArg || !backupArg || !stageArg || (action === 'switch' && !reviewArg)) {
    throw Error('Usage: switch-recovery-host.mjs or switch-release-host.mjs <prepare|switch> <current-host> <staged-host> <current-nine-volume-backup> <stage-receipt> [private-review]');
  }
  const base = join(homedir(), 'Library/Application Support/Clawbot');
  const oldDirectory = resolve(oldArg), newDirectory = resolve(newArg), backupDirectory = resolve(backupArg);
  for (const directory of [oldDirectory, newDirectory]) assert.ok(directory.startsWith(join(base, 'production-host-releases') + '/') && realpathSync(directory) === directory);
  assert.ok(backupDirectory.startsWith(join(base, 'production-backups') + '/') && realpathSync(backupDirectory) === backupDirectory);
  const before = readManagedHostRelease(oldDirectory).spec, after = readManagedHostRelease(newDirectory).spec;
  const oldDriver = managedDockerDriver(before, join(oldDirectory, 'compose.json')), newDriver = managedDockerDriver(after, join(newDirectory, 'compose.json'));
  const oldJob = managedHostJob(oldDirectory), newJob = managedHostJob(newDirectory);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  function privateBytes(path, maxBytes = 65536) {
    const st = lstatSync(path);
    assert.ok(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.uid === process.getuid()
      && !(st.mode & 0o077) && st.size <= maxBytes && realpathSync(path) === path);
    return readFileSync(path);
  }
  function operationFile(arg) {
    const path = resolve(arg); assert.ok(path.startsWith(operationsRoot + '/')); return path;
  }
  let unlock = await waitForOperationLock(updating ? 'release-host-switch' : 'recovery-host-switch'), journal;
  const checkpoint = async phase => {
    if (journal !== undefined) { writeFileSync(journal, JSON.stringify({ phase, at: new Date().toISOString() }) + '\n'); fsyncSync(journal); }
  };
  try {
    const gatePath = join(operationsRoot, 'production-enabled.json'), maintenancePath = join(operationsRoot, 'production-maintenance');
    const oldGateBytes = privateBytes(gatePath), oldGate = JSON.parse(oldGateBytes), oldMaintenanceBytes = privateBytes(maintenancePath);
    const oldMaintenance = JSON.parse(oldMaintenanceBytes);
    assert.ok(activationMatches(oldGate, before));
    for (const key of ['project', 'sourceCommit', 'cutoverId', 'importManifestSha256']) assert.equal(oldMaintenance[key], before[key]);
    assert.equal(oldMaintenance.volumeGeneration ?? null, before.volumeGeneration ?? null);
    assert.ok(!existsSync(join(operationsRoot, 'production-storage-fault.json')), 'Resolve the current fault under maintenance before selecting other data');
    oldJob.installed(); oldJob.loaded();
    const manifestPath = join(backupDirectory, 'manifest.json'), manifestBytes = privateBytes(manifestPath), manifest = JSON.parse(manifestBytes);
    const verified = JSON.parse(privateBytes(join(backupDirectory, 'verified.json')));
    assert.equal(manifest.format, 'clawbot-nine-volume-aes256gcm-v1'); assert.equal(manifest.project, before.project);
    assert.equal(manifest.runtimeImage, before.services.openclaw.image); assert.equal(manifest.volumeGeneration ?? null, before.volumeGeneration ?? null);
    assert.deepEqual(manifest.volumes, MIGRATION_ROLES);
    assert.equal(verified.status, 'restored-and-verified'); assert.equal(verified.volumes, 9);
    assert.ok(verified.fileInventory === true && verified.ledgerAndReceiptIntegrity === true && verified.restoreNetwork === 'none');
    const archive = join(backupDirectory, 'state.enc'), ast = lstatSync(archive);
    assert.ok(ast.isFile() && !ast.isSymbolicLink() && ast.nlink === 1 && ast.uid === process.getuid() && !(ast.mode & 0o077) && ast.size <= 20 * 2 ** 30);
    const key = privateBytes(join(base, 'production-backup-keys/clawbot-production.key'), 32); assert.equal(key.length, 32);
    await decryptArchive(archive, key, manifest);
    const stagePath = operationFile(stageArg), stageBytes = privateBytes(stagePath), stage = JSON.parse(stageBytes);
    if (updating) validateReleaseUpdateSelection(stage, before, after, manifest, hash(manifestBytes));
    else assert.equal(stage.status, 'CLAWBOT_RECOVERY_GENERATION_STAGED');
    assert.equal(stage.productionActivated, false);
    for (const field of ['project', 'sourceCommit', 'cutoverId', 'importManifestSha256', 'volumeGeneration', 'recoverySourceManifestSha256', 'volumePrefix']) assert.equal(stage[field], after[field]);
    const evidence = { currentBackupManifestSha256: hash(manifestBytes), currentAuditSha256: hash(JSON.stringify(manifest.audit)),
      stageReceiptSha256: hash(stageBytes), selectedAuditSha256: hash(JSON.stringify(stage.stagedAudit)) };
    const template = (updating ? releaseUpdateSwitchTemplate : generationSwitchTemplate)(before, after, evidence);
    const newGateBytes = Buffer.from(JSON.stringify({ ...oldGate, sourceCommit: after.sourceCommit, volumeGeneration: after.volumeGeneration, recoverySourceManifestSha256: after.recoverySourceManifestSha256 }));
    const newMaintenanceBytes = Buffer.from(JSON.stringify({ ...oldMaintenance, sourceCommit: after.sourceCommit, volumeGeneration: after.volumeGeneration, nonce: randomUUID() }));
    const managedFiles = [[gatePath, oldGateBytes, newGateBytes], [maintenancePath, oldMaintenanceBytes, newMaintenanceBytes], [oldJob.plist, oldJob.bytes, newJob.bytes]];
    const verifyData = async () => {
      assert.ok(!existsSync(join(operationsRoot, 'production-storage-fault.json')));
      for (const [path, oldBytes, newBytes] of managedFiles) {
        const actual = privateBytes(path); assert.ok(actual.equals(oldBytes) || actual.equals(newBytes), 'Unknown managed file change');
      }
      assert.deepEqual(privateBytes(manifestPath), manifestBytes); assert.deepEqual(privateBytes(stagePath), stageBytes);
      assert.deepEqual(await auditManagedState(before, oldDriver), manifest.audit);
      assert.deepEqual(await auditManagedState(after, newDriver), stage.stagedAudit);
    };
    await verifyData();
    if (action === 'prepare') {
      const path = join(operationsRoot, `${updating ? "release-update" : "generation"}-switch-review-${after.volumeGeneration}.json`);
      writeFileSync(path, JSON.stringify(template, null, 2), { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ status: updating ? 'CLAWBOT_RELEASE_UPDATE_SWITCH_REVIEW_ALL_UNCONFIRMED' : 'CLAWBOT_GENERATION_SWITCH_REVIEW_ALL_UNCONFIRMED', path }));
    } else {
      const reviewPath = operationFile(reviewArg), reviewBytes = privateBytes(reviewPath), review = JSON.parse(reviewBytes);
      const journalPath = join(operationsRoot, `${updating ? "release-update" : "generation"}-switch-${Date.now()}-${randomUUID()}.jsonl`);
      journal = openSync(journalPath, 'wx', 0o600);
      writeFileSync(journal, JSON.stringify({ version: 1, operation, before: oldDirectory, after: newDirectory, review,
        files: managedFiles.map(([path, oldBytes, newBytes]) => ({ path, old: oldBytes.toString('base64'), next: newBytes.toString('base64') })) }) + '\n'); fsyncSync(journal);
      const result = await (updating ? switchReleaseUpdateInMaintenance : switchGenerationInMaintenance)({ before, after, oldDriver, newDriver, review, evidence,
        verifyData: async () => { assert.deepEqual(privateBytes(reviewPath), reviewBytes); await verifyData(); },
        stopHost: async (spec, options) => { await (spec === before ? oldJob : newJob).stop(options); },
        selectHost: async spec => {
          // Maintenance is replaced first and never removed, including rollback.
          for (const index of [1, 0, 2]) {
            const [path, oldBytes, newBytes] = managedFiles[index], actual = privateBytes(path);
            assert.ok(actual.equals(oldBytes) || actual.equals(newBytes));
            const target = spec === before ? oldBytes : newBytes;
            if (!actual.equals(target)) atomicPrivateReplace(path, actual, target);
          }
        },
        startHost: async spec => { (spec === before ? oldJob : newJob).start(); }, checkpoint,
      });
      const selected = result.status === (updating ? 'CLAWBOT_RELEASE_UPDATE_SELECTED_IN_MAINTENANCE' : 'CLAWBOT_GENERATION_SELECTED_IN_MAINTENANCE') ? after : before;
      const selectedJob = selected === after ? newJob : oldJob;
      const started = Date.now(); unlock(); unlock = null;
      let ready = false;
      while (Date.now() - started < 60000) {
        try {
          const state = JSON.parse(privateBytes(join(operationsRoot, 'production-host-status.json')));
          if (state.sourceCommit === selected.sourceCommit && (state.volumeGeneration ?? null) === (selected.volumeGeneration ?? null)
            && state.state === 'maintenance' && state.storageFault === false && Date.parse(state.updatedAt) >= started) {
            selectedJob.installed(); const loaded = selectedJob.loaded();
            if (Number(loaded.pid) === state.pid) { ready = true; break; }
          }
        } catch {}
        await delay(500);
      }
      assert.ok(ready, 'Selected host did not confirm fresh maintenance; inspect without resuming');
      await checkpoint('selected-host-maintenance-verified');
      console.log(JSON.stringify({ ...result, maintenanceVerified: true, journalPath }));
    }
  } catch { await checkpoint('needs-inspection-do-not-resume'); console.error(updating ? 'CLAWBOT_RELEASE_HOST_SWITCH_NEEDS_INSPECTION' : 'CLAWBOT_RECOVERY_HOST_SWITCH_NEEDS_INSPECTION'); process.exitCode = 1; }
  finally { unlock?.(); if (journal !== undefined) closeSync(journal); }
}
