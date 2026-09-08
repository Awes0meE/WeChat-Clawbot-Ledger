import assert from 'node:assert/strict';
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readManagedHostRelease, activationMatches } from './managed-host-release.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { managedHostJob } from './managed-host-job.mjs';
import { operationsRoot, waitForOperationLock } from './operation-lock.mjs';
import { auditManagedState } from './managed-state-audit.mjs';
import { decryptArchive } from './backup-crypto.mjs';
import { MIGRATION_ROLES } from '../../deploy/docker/migration-format.mjs';
export const credentialHash=value=>createHash('sha256').update(value).digest('hex');
export function credentialPrivateBytes(path,max=65536) {
  const s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()
    &&!(s.mode&0o077)&&s.size<=max&&realpathSync(path)===path);return readFileSync(path);
}
function absent(path){try{lstatSync(path);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}}
export async function credentialMaintenanceContext(hostArg,backupArg,operation,{allowChangedState=false}={}) {
  const base=join(homedir(),'Library/Application Support/Clawbot'),host=resolve(hostArg),backup=resolve(backupArg);
  assert.ok(host.startsWith(join(base,'production-host-releases')+'/')&&realpathSync(host)===host);
  assert.ok(backup.startsWith(join(base,'production-backups')+'/')&&realpathSync(backup)===backup);
  const {spec}=readManagedHostRelease(host),driver=managedDockerDriver(spec,join(host,'compose.json'));
  const unlock=await waitForOperationLock(operation);
  try {
    const maintenancePath=join(operationsRoot,'production-maintenance'),maintenanceBytes=credentialPrivateBytes(maintenancePath);
    const marker=JSON.parse(maintenanceBytes);
    for(const key of ['project','sourceCommit','cutoverId','importManifestSha256'])assert.equal(marker[key],spec[key]);
    assert.equal(marker.volumeGeneration??null,spec.volumeGeneration??null);
    const manifestBytes=credentialPrivateBytes(join(backup,'manifest.json')),manifest=JSON.parse(manifestBytes);
    const verifiedBytes=credentialPrivateBytes(join(backup,'verified.json')),verified=JSON.parse(verifiedBytes);
    assert.equal(manifest.format,'clawbot-nine-volume-aes256gcm-v1');assert.equal(manifest.project,spec.project);
    assert.equal(manifest.runtimeImage,spec.services.openclaw.image);assert.deepEqual(manifest.volumes,MIGRATION_ROLES);
    assert.equal(manifest.volumeGeneration??null,spec.volumeGeneration??null);
    assert.ok(verified.status==='restored-and-verified'&&verified.volumes===9&&verified.fileInventory===true
      &&verified.ledgerAndReceiptIntegrity===true&&verified.restoreNetwork==='none');
    const archive=join(backup,'state.enc'),s=lstatSync(archive);
    assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&!(s.mode&0o077)
      &&s.size<=20*2**30&&realpathSync(archive)===archive);
    const key=credentialPrivateBytes(join(base,'production-backup-keys/clawbot-production.key'),32);assert.equal(key.length,32);
    await decryptArchive(archive,key,manifest);
    const job=managedHostJob(host);
    async function assertQuiescent() {
      assert.ok(credentialPrivateBytes(maintenancePath).equals(maintenanceBytes)
        &&credentialPrivateBytes(join(backup,'manifest.json')).equals(manifestBytes)
        &&credentialPrivateBytes(join(backup,'verified.json')).equals(verifiedBytes));
      assert.ok(absent(join(operationsRoot,'production-storage-fault.json')));
      assert.ok(activationMatches(JSON.parse(credentialPrivateBytes(join(operationsRoot,'production-enabled.json'))),spec));
      job.installed();job.loaded();
      const view=await driver.inspect();assert.ok(view.identityValid&&!Object.values(view.running).some(Boolean));
      return await auditManagedState(spec,driver);
    }
    async function assertBackupUnchanged(){assert.deepEqual(await assertQuiescent(),manifest.audit);}
    if(allowChangedState)await assertQuiescent();else await assertBackupUnchanged();
    return {spec,driver,manifest,assertQuiescent,assertBackupUnchanged,unlock,evidence:{sourceCommit:spec.sourceCommit,
      runtimeImage:spec.services.openclaw.image,cutoverId:spec.cutoverId,volumeGeneration:spec.volumeGeneration??null,
      maintenanceSha256:credentialHash(maintenanceBytes),backupManifestSha256:credentialHash(manifestBytes)}};
  }catch(e){unlock();throw e;}
}
