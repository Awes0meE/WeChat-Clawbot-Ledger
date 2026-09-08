import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { readManagedHostRelease, activationMatches } from './managed-host-release.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { managedHostJob } from './managed-host-job.mjs';
import { managedVolumeName } from './managed-runtime-spec.mjs';
import { auditManagedState } from './managed-state-audit.mjs';
import { operationsRoot, waitForOperationLock } from './operation-lock.mjs';
import { assertBackupBudget } from './backup-budget.mjs';
import { checkLedgerTokenClone } from './ledger-token-clone-check.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function privateBytes(path, max = 65536) {
  const s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()
    &&!(s.mode&0o077)&&s.size<=max&&realpathSync(path)===path);return readFileSync(path);
}
function absent(path) { try{lstatSync(path);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;} }
let unlock;
try {
  assert.equal(process.argv.length,4);
  const base=join(homedir(),'Library/Application Support/Clawbot'), host=resolve(process.argv[2]), receiptPath=resolve(process.argv[3]);
  assert.ok(host.startsWith(join(base,'production-host-releases')+'/')&&realpathSync(host)===host);
  const records=join(operationsRoot,'ledger-token-updates'), bytes=privateBytes(receiptPath), saved=JSON.parse(bytes);
  assert.match(saved.binding,/^[a-f0-9]{64}$/);assert.equal(receiptPath,join(records,`saved-${saved.binding}.json`));
  assert.ok(['CLAWBOT_LEDGER_TOKENS_SAVED_MAINTENANCE_REQUIRED','CLAWBOT_LEDGER_SAVED_PAIR_VERIFIED'].includes(saved.status));
  assert.ok(saved.version===1&&saved.maintenanceRequired===true&&saved.remoteVerified===false);
  const {spec}=readManagedHostRelease(host),driver=managedDockerDriver(spec,join(host,'compose.json'));
  assert.equal(saved.sourceCommit,spec.sourceCommit);assert.equal(saved.runtimeImage,spec.services.openclaw.image);
  assert.equal(saved.cutoverId,spec.cutoverId);assert.equal(saved.volumeGeneration,spec.volumeGeneration??null);
  const startedPath=join(records,`started-${saved.binding}.json`),startedBytes=privateBytes(startedPath),started=JSON.parse(startedBytes);
  for(const [key,value] of Object.entries(started))assert.deepEqual(saved[key],value);
  assert.equal(started.binding,saved.binding);assert.equal(started.version,1);
  const maintenancePath=join(operationsRoot,'production-maintenance'),maintenanceBytes=privateBytes(maintenancePath);
  assert.equal(hash(maintenanceBytes),saved.maintenanceSha256);
  const marker=JSON.parse(maintenanceBytes);
  for(const key of ['project','sourceCommit','cutoverId','importManifestSha256'])assert.equal(marker[key],spec[key]);
  assert.equal(marker.volumeGeneration??null,spec.volumeGeneration??null);
  unlock=await waitForOperationLock('ledger-saved-token-check');
  const job=managedHostJob(host);
  async function assertSourceUnchanged() {
    assert.ok(privateBytes(receiptPath).equals(bytes)&&privateBytes(startedPath).equals(startedBytes)
      &&privateBytes(maintenancePath).equals(maintenanceBytes));
    assert.ok(absent(join(operationsRoot,'production-storage-fault.json')));
    assert.ok(activationMatches(JSON.parse(privateBytes(join(operationsRoot,'production-enabled.json'))),spec));
    job.installed();job.loaded();
    const view=await driver.inspect();assert.ok(view.identityValid&&!Object.values(view.running).some(Boolean));
    assert.ok(await driver.validateInputs());
    assert.deepEqual(await auditManagedState(spec,driver),saved.afterAudit);
  }
  await assertSourceUnchanged();
  const storage=await driver.storage();
  assertBackupBudget({freeBytes:Math.min(storage.hostFreeBytes,storage.volumeFreeBytes),existingBytes:0,
    sourceBytes:saved.afterAudit.bytes,entries:saved.afterAudit.entries});
  const result=await checkLedgerTokenClone({run:driver.run,runtimeImage:spec.services.openclaw.image,sourceProfile:'production',
    volumes:{config:managedVolumeName(spec,'ledger-config'),ledger:managedVolumeName(spec,'ledger-data'),
      secrets:managedVolumeName(spec,'secrets')},assertSourceUnchanged});
  await assertSourceUnchanged();
  const receipt=join(records,`checked-${saved.binding}-${randomUUID()}.json`);
  writeFileSync(receipt,JSON.stringify({...result,binding:saved.binding,savedReceiptSha256:hash(bytes),
    sourceCommit:spec.sourceCommit,runtimeImage:spec.services.openclaw.image}),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({...result,receipt}));
  if(!result.serverAcceptanceVerified)process.exitCode=2;
} catch {console.error('CLAWBOT_SAVED_TOKEN_CHECK_STOPPED_MAINTENANCE_REMAINS');process.exitCode=1;}
finally {unlock?.();}
