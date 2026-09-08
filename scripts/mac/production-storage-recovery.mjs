import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readManagedHostRelease, activationMatches } from './managed-host-release.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { storageRecoveryTemplate, clearReviewedStorageFault } from './storage-recovery-review.mjs';
import { waitForOperationLock, operationsRoot } from './operation-lock.mjs';
import { decryptArchive } from './backup-crypto.mjs';
import { MIGRATION_ROLES } from '../../deploy/docker/migration-format.mjs';
import { archiveReviewedStorageFault } from './archive-storage-fault.mjs';
import { managedVolumeName } from './managed-runtime-spec.mjs';

const [action, hostArg, backupArg, reviewArg] = process.argv.slice(2);
if (!['prepare', 'clear'].includes(action) || !hostArg || !backupArg || (action === 'clear' && !reviewArg)) {
  throw Error('Usage: production-storage-recovery.mjs <prepare|clear> <immutable-host> <nine-volume-backup> [private-review]');
}
const base = join(homedir(), 'Library/Application Support/Clawbot'), host = resolve(hostArg), backup = resolve(backupArg);
assert.ok(host.startsWith(join(base, 'production-host-releases') + '/') && realpathSync(host) === host);
assert.ok(backup.startsWith(join(base, 'production-backups') + '/') && realpathSync(backup) === backup);
const { spec } = readManagedHostRelease(host), driver = managedDockerDriver(spec, join(host, 'compose.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
function privateBytes(path, budget = 65536) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid()
    && !(stat.mode & 0o077) && stat.size <= budget && realpathSync(path) === path);
  return readFileSync(path);
}
const faultPath = join(operationsRoot, 'production-storage-fault.json'), maintenancePath = join(operationsRoot, 'production-maintenance');
const unlock = await waitForOperationLock('production-storage-review');
try {
  const faultBytes = privateBytes(faultPath), fault = JSON.parse(faultBytes), maintenanceBytes = privateBytes(maintenancePath);
  for (const marker of [fault, JSON.parse(maintenanceBytes)]) {
    assert.equal(marker.version, 1); assert.equal(marker.project, spec.project);
    assert.equal(marker.sourceCommit, spec.sourceCommit); assert.equal(marker.cutoverId, spec.cutoverId);
    assert.equal(marker.volumeGeneration ?? null, spec.volumeGeneration ?? null);
  }
  assert.equal(fault.requiresDataReconciliation, true);
  assert.equal(JSON.parse(maintenanceBytes).importManifestSha256, spec.importManifestSha256);
  const manifestBytes = privateBytes(join(backup, 'manifest.json')), manifest = JSON.parse(manifestBytes);
  const verified = JSON.parse(privateBytes(join(backup, 'verified.json')));
  assert.equal(manifest.format, 'clawbot-nine-volume-aes256gcm-v1'); assert.equal(manifest.project, spec.project);
  assert.equal(manifest.runtimeImage, spec.services.openclaw.image); assert.deepEqual(manifest.volumes, MIGRATION_ROLES);
  assert.equal(manifest.volumeGeneration ?? null, spec.volumeGeneration ?? null);
  assert.equal(verified.status, 'restored-and-verified'); assert.equal(verified.volumes, 9);
  assert.ok(verified.fileInventory === true && verified.ledgerAndReceiptIntegrity === true && verified.restoreNetwork === 'none');
  const keyPath = join(base, 'production-backup-keys', 'clawbot-production.key'), key = privateBytes(keyPath, 32);
  assert.equal(key.length, 32);
  const archivePath = join(backup, 'state.enc'), as = lstatSync(archivePath);
  assert.ok(as.isFile() && !as.isSymbolicLink() && as.nlink === 1 && as.uid === process.getuid() && !(as.mode & 0o077) && as.size <= 20 * 2 ** 30);
  await decryptArchive(archivePath, key, manifest);
  const evidence = { faultSha256: hash(faultBytes), backupManifestSha256: hash(manifestBytes),
    dataAuditSha256: hash(JSON.stringify(manifest.audit)) };
  async function verifyEvidence() {
    assert.deepEqual(privateBytes(faultPath), faultBytes); assert.deepEqual(privateBytes(maintenancePath), maintenanceBytes);
    assert.deepEqual(privateBytes(join(backup, 'manifest.json')), manifestBytes);
    assert.ok(activationMatches(JSON.parse(privateBytes(join(operationsRoot, 'production-enabled.json'))), spec));
    assert.ok(await driver.validateVolumes());
    const view = await driver.inspect(); assert.ok(view.identityValid && Object.values(view.running).every(v => !v));
    const ids = (await driver.run(['ps', '-q'])).split('\n').filter(Boolean);
    const names = MIGRATION_ROLES.map(role => managedVolumeName(spec, role));
    if (ids.length) {
      const live = JSON.parse(await driver.run(['inspect', ...ids]));
      assert.ok(live.every(c => !c.Mounts.some(m => names.includes(m.Name))), 'A volume has a live consumer');
    }
    const audit = JSON.parse(await driver.run(['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
      '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--security-opt', 'no-new-privileges:true',
      ...MIGRATION_ROLES.flatMap(role => ['--mount', `type=volume,src=${managedVolumeName(spec, role)},dst=/state/${role},readonly`]),
      '--entrypoint', 'node', spec.services.openclaw.image, '/opt/clawbot/docker/nine-volume-audit.mjs'], 120000));
    assert.deepEqual(audit, manifest.audit, 'Current nine-volume data differs from reviewed backup');
  }
  if (action === 'prepare') {
    await verifyEvidence();
    const path = join(operationsRoot, `storage-review-${evidence.faultSha256}.json`);
    writeFileSync(path, JSON.stringify(storageRecoveryTemplate(spec, evidence), null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ status: 'CLAWBOT_STORAGE_REVIEW_ALL_UNCONFIRMED', path }));
  } else {
    const reviewPath = resolve(reviewArg); assert.ok(reviewPath.startsWith(operationsRoot + '/'));
    const reviewBytes = privateBytes(reviewPath), review = JSON.parse(reviewBytes);
    const label = 'com.clawbot.mac-production-host', domain = `gui/${process.getuid()}`;
    const plist = join(homedir(), 'Library/LaunchAgents', `${label}.plist`), installed = privateBytes(plist);
    function command(file, args) {
      const r = spawnSync(file, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
      if (r.status !== 0) throw Error('CLAWBOT_STORAGE_HOST_COMMAND_FAILED'); return r.stdout;
    }
    const job = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]));
    assert.deepEqual(job, { Label: label, ProgramArguments: [process.execPath, join(host, 'production-host.mjs')],
      RunAtLoad: true, KeepAlive: true, ThrottleInterval: 30, StandardOutPath: '/dev/null', StandardErrorPath: '/dev/null' });
    await clearReviewedStorageFault({ driver, spec, review, evidence,
      verifyEvidence: async () => { assert.deepEqual(privateBytes(reviewPath), reviewBytes); await verifyEvidence(); },
      stopHost: async () => {
        const loaded = command('/bin/launchctl', ['list', label]);
        const args = [...(loaded.match(/"ProgramArguments" = \(([\s\S]*?)\);/)?.[1] ?? '').matchAll(/"([^"\n]+)";/g)].map(m => m[1]);
        assert.deepEqual(args, job.ProgramArguments);
        const pid = loaded.match(/"PID" = (\d+);/)?.[1]; assert.ok(pid);
        assert.equal(command('/bin/ps', ['-p', pid, '-o', 'command=']).trim(), job.ProgramArguments.join(' '));
        assert.deepEqual(privateBytes(plist), installed);
        command('/bin/launchctl', ['bootout', `${domain}/${label}`]);
        const until = Date.now() + 30000;
        while (Date.now() < until && spawnSync('/bin/launchctl', ['list', label]).status === 0) await delay(250);
        assert.notEqual(spawnSync('/bin/launchctl', ['list', label]).status, 0);
        assert.notEqual(spawnSync('/bin/ps', ['-p', pid, '-o', 'pid=']).status, 0, 'Old host process still exists');
      },
      archiveAndClear: async () => {
        assert.deepEqual(privateBytes(faultPath), faultBytes);
        archiveReviewedStorageFault({ faultPath, archivePath: join(operationsRoot, `storage-fault-cleared-${evidence.faultSha256}.json`), faultBytes, reviewBytes });
      },
      restartHost: async () => {
        assert.deepEqual(privateBytes(plist), installed); assert.deepEqual(privateBytes(maintenancePath), maintenanceBytes);
        assert.ok(!existsSync(faultPath)); command('/bin/launchctl', ['bootstrap', domain, plist]);
      },
    });
    console.log('CLAWBOT_STORAGE_FAULT_CLEARED_MAINTENANCE_REMAINS_VERIFY_HOST_BEFORE_RESUME');
  }
} catch { console.error('CLAWBOT_STORAGE_RECOVERY_STOPPED_FOR_REVIEW_MAINTENANCE_REMAINS'); process.exitCode = 1; }
finally { unlock(); }
