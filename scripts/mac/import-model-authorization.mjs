import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync, realpathSync, existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { readManagedHostRelease, activationMatches } from './managed-host-release.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { managedHostJob } from './managed-host-job.mjs';
import { auditManagedState } from './managed-state-audit.mjs';
import { validateAuthorizationStage } from './authorization-stage.mjs';
import { decryptArchive } from './backup-crypto.mjs';
import { operationsRoot, waitForOperationLock } from './operation-lock.mjs';
import { MIGRATION_ROLES } from '../../deploy/docker/migration-format.mjs';
import { managedVolumeName } from './managed-runtime-spec.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function privateBytes(path, max = 65536) {
  const s = lstatSync(path);
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === process.getuid()
    && !(s.mode & 0o077) && s.size <= max && realpathSync(path) === path);
  return readFileSync(path);
}
let unlock, stageLock;
try {
  const [action, hostArg, stageArg, backupArg, reviewArg] = process.argv.slice(2);
  assert.ok(['prepare', 'apply'].includes(action) && hostArg && stageArg && backupArg
    && process.argv.length === (action === 'prepare' ? 6 : 7));
  const base = join(homedir(), 'Library/Application Support/Clawbot');
  const host = resolve(hostArg), stageFile = resolve(stageArg), backup = resolve(backupArg);
  assert.ok(host.startsWith(join(base, 'production-host-releases') + '/') && realpathSync(host) === host);
  assert.ok(backup.startsWith(join(base, 'production-backups') + '/') && realpathSync(backup) === backup);
  const stageBytes = privateBytes(stageFile), stage = validateAuthorizationStage(JSON.parse(stageBytes));
  assert.equal(stageFile, join(operationsRoot, 'authorization-stages', `${stage.id}.json`));
  const { spec } = readManagedHostRelease(host), driver = managedDockerDriver(spec, join(host, 'compose.json'));
  assert.equal(stage.targetProfile, 'production'); assert.equal(stage.runtimeImage, spec.services.openclaw.image);
  assert.equal(stage.hostSourceCommit, spec.sourceCommit);
  unlock = await waitForOperationLock('model-authorization-import');
  const lock = stageFile + '.lock'; mkdirSync(lock, { mode: 0o700 }); stageLock = lock;
  const maintenancePath = join(operationsRoot, 'production-maintenance'), gatePath = join(operationsRoot, 'production-enabled.json');
  const maintenanceBytes = privateBytes(maintenancePath), marker = JSON.parse(maintenanceBytes);
  for (const key of ['project', 'sourceCommit', 'cutoverId', 'importManifestSha256']) assert.equal(marker[key], spec[key]);
  assert.equal(marker.volumeGeneration ?? null, spec.volumeGeneration ?? null);
  assert.ok(activationMatches(JSON.parse(privateBytes(gatePath)), spec));
  assert.ok(!existsSync(join(operationsRoot, 'production-storage-fault.json')));
  const job = managedHostJob(host); job.installed(); job.loaded();
  const manifestBytes = privateBytes(join(backup, 'manifest.json')), manifest = JSON.parse(manifestBytes);
  const verified = JSON.parse(privateBytes(join(backup, 'verified.json')));
  assert.equal(manifest.format, 'clawbot-nine-volume-aes256gcm-v1'); assert.equal(manifest.project, spec.project);
  assert.equal(manifest.runtimeImage, spec.services.openclaw.image); assert.deepEqual(manifest.volumes, MIGRATION_ROLES);
  assert.equal(manifest.volumeGeneration ?? null, spec.volumeGeneration ?? null);
  assert.ok(verified.status === 'restored-and-verified' && verified.volumes === 9
    && verified.fileInventory === true && verified.ledgerAndReceiptIntegrity === true && verified.restoreNetwork === 'none');
  const archive = join(backup, 'state.enc'), as = lstatSync(archive);
  assert.ok(as.isFile() && !as.isSymbolicLink() && as.nlink === 1 && as.uid === process.getuid() && !(as.mode & 0o077) && as.size <= 20 * 2 ** 30);
  const key = privateBytes(join(base, 'production-backup-keys/clawbot-production.key'), 32); assert.equal(key.length, 32);
  await decryptArchive(archive, key, manifest);
  async function quiescent() {
    assert.ok(privateBytes(stageFile).equals(stageBytes) && privateBytes(maintenancePath).equals(maintenanceBytes));
    assert.ok(privateBytes(join(backup, 'manifest.json')).equals(manifestBytes));
    assert.ok(!existsSync(join(operationsRoot, 'production-storage-fault.json')));
    assert.ok(activationMatches(JSON.parse(privateBytes(gatePath)), spec));
    const view = await driver.inspect(); assert.ok(view.identityValid && !Object.values(view.running).some(Boolean));
    const volume = JSON.parse(await driver.run(['volume', 'inspect', stage.volume]))[0];
    assert.ok(volume.Driver === 'local' && !Object.keys(volume.Options ?? {}).length
      && volume.Labels?.['clawbot.purpose'] === 'authorization-stage' && volume.Labels['clawbot.stage'] === stage.id
      && !volume.Labels['clawbot.project'] && !volume.Labels['clawbot.cutover']);
    assert.equal(await driver.run(['ps', '-q', '--filter', `volume=${stage.volume}`]), '');
  }
  async function helper(mode, binding) {
    return JSON.parse(await driver.run(['run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777',
      '--mount', `type=volume,src=${stage.volume},dst=/authorization-source,readonly`,
      '--mount', `type=volume,src=${managedVolumeName(spec, 'openclaw-state')},dst=/var/lib/clawbot/openclaw${mode === 'inspect' ? ',readonly' : ''}`,
      '--mount', `type=volume,src=${managedVolumeName(spec, 'runtime-config')},dst=/run/clawbot-runtime,readonly`,
      '--env', 'HOME=/var/lib/clawbot/openclaw', '--env', 'OPENCLAW_STATE_DIR=/var/lib/clawbot/openclaw',
      '--env', 'OPENCLAW_CONFIG_PATH=/run/clawbot-runtime/openclaw.json', '--env', 'CODEX_HOME=/tmp/unused-codex',
      '--entrypoint', 'node', spec.services.openclaw.image, '/opt/clawbot/docker/import-model-authorization.mjs', mode,
      ...(binding ? [binding] : [])], 120000));
  }
  await quiescent(); assert.deepEqual(await auditManagedState(spec, driver), manifest.audit);
  const inspection = await helper('inspect');
  assert.equal(inspection.status, 'CLAWBOT_AUTH_IMPORT_READY_FOR_REVIEW'); assert.match(inspection.binding, /^[a-f0-9]{64}$/);
  const evidence = { version: 1, sourceCommit: spec.sourceCommit, stageId: stage.id,
    backupManifestSha256: hash(manifestBytes), binding: inspection.binding };
  if (action === 'prepare') {
    const file = join(operationsRoot, `model-authorization-review-${randomUUID()}.json`);
    writeFileSync(file, JSON.stringify({ ...evidence, approved: false, reviewedAt: null }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ status: 'CLAWBOT_AUTH_IMPORT_REVIEW_UNCONFIRMED', file }));
  } else {
    const reviewPath = resolve(reviewArg); assert.ok(reviewPath.startsWith(operationsRoot + '/'));
    const review = JSON.parse(privateBytes(reviewPath));
    for (const [k, v] of Object.entries(evidence)) assert.equal(review[k], v);
    const age = Date.now() - Date.parse(review.reviewedAt); assert.ok(review.approved === true && age >= 0 && age <= 30 * 60000);
    await quiescent();
    // Revalidate the exact current backup and absence of all consumers.
    assert.deepEqual(await auditManagedState(spec, driver), manifest.audit);
    const result = await helper('apply', inspection.binding); assert.equal(result.status, 'CLAWBOT_AUTH_IMPORTED_MAINTENANCE_REQUIRED');
    await quiescent(); const after = await auditManagedState(spec, driver);
    assert.deepEqual(after.databases, manifest.audit.databases);
    const receipt = join(operationsRoot, `model-authorization-import-${randomUUID()}.json`);
    writeFileSync(receipt, JSON.stringify({ ...evidence, status: result.status, at: new Date().toISOString(),
      unrelatedStatePreserved: true, remoteVerified: false, afterAudit: after }), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ status: result.status, receipt, remoteVerified: false }));
  }
} catch { console.error('CLAWBOT_AUTH_IMPORT_STOPPED_MAINTENANCE_REMAINS'); process.exitCode = 1; }
finally { if (stageLock) rmdirSync(stageLock); unlock?.(); }
