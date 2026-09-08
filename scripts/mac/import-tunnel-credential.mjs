import assert from 'node:assert/strict';
import { mkdirSync,lstatSync,realpathSync,openSync,writeFileSync,fsyncSync,closeSync } from 'node:fs';
import { join,resolve,dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { operationsRoot } from './operation-lock.mjs';
import { credentialMaintenanceContext,credentialPrivateBytes,credentialHash } from './credential-maintenance-context.mjs';
import { tunnelCredentialArgs } from './tunnel-credential-policy.mjs';
import { auditManagedState } from './managed-state-audit.mjs';
import { applySingleCredentialUpdate } from './single-credential-operation.mjs';
function durableRecord(path,value) {
  const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}
  const parent=openSync(dirname(path),'r');try{fsyncSync(parent);}finally{closeSync(parent);}
}
let context;
try {
  const [action,host,backup,inputArg,reviewArg]=process.argv.slice(2);
  assert.ok(['prepare','apply','resume'].includes(action)&&host&&backup&&inputArg&&process.argv.length===(action==='prepare'?6:7));
  context=await credentialMaintenanceContext(host,backup,'tunnel-credential-import',{allowChangedState:action==='resume'});
  const {spec,driver,manifest}=context,input=resolve(inputArg);
  assert.ok(input.startsWith(operationsRoot+'/'));
  const candidateBytes=credentialPrivateBytes(input,4096);
  const records=join(operationsRoot,'tunnel-credential-updates');mkdirSync(records,{recursive:true,mode:0o700});
  const stat=lstatSync(records);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===process.getuid()
    &&!(stat.mode&0o077)&&realpathSync(records)===records);
  const evidence={version:1,...context.evidence,candidateSha256:credentialHash(candidateBytes)};
  async function fullAudit() {
    assert.ok(credentialPrivateBytes(input,4096).equals(candidateBytes));return await context.assertQuiescent();
  }
  async function unrelatedAudit() {
    await fullAudit();const audit=await auditManagedState(spec,driver,{tunnelCredential:true});
    assert.equal(audit.scope,'excluding-tunnel-credential');return audit;
  }
  async function helper(mode,review) {
    const target={sourceCommit:spec.sourceCommit,sourceSnapshotSha256:spec.sourceSnapshotSha256,cutoverId:spec.cutoverId};
    const r=spawnSync('/Applications/Docker.app/Contents/Resources/bin/docker',tunnelCredentialArgs(spec,mode),
      {input:JSON.stringify({candidateText:candidateBytes.toString('utf8'),target,review}),encoding:'utf8',timeout:120000,maxBuffer:65536});
    assert.equal(r.status,0);return JSON.parse(r.stdout);
  }
  if(action==='prepare') {
    assert.deepEqual(await fullAudit(),manifest.audit);
    const inspection=await helper('inspect');assert.equal(inspection.status,'CLAWBOT_TUNNEL_CREDENTIAL_READY_FOR_REVIEW');
    assert.equal(inspection.binding,credentialHash(JSON.stringify(inspection.review)));
    const unrelated=await unrelatedAudit();assert.deepEqual(await fullAudit(),manifest.audit);
    const file=join(records,`review-${randomUUID()}.json`);
    durableRecord(file,{...evidence,binding:inspection.binding,helperReview:inspection.review,unrelatedAudit:unrelated,approved:false,reviewedAt:null});
    console.log(JSON.stringify({status:'CLAWBOT_TUNNEL_IMPORT_REVIEW_UNCONFIRMED',file,maintenanceRequired:true}));
  }else {
    const file=resolve(reviewArg);assert.equal(dirname(file),records);const bytes=credentialPrivateBytes(file);
    console.log(JSON.stringify(await applySingleCredentialUpdate({kind:'tunnel',action,evidence,manifest,reviewBytes:bytes,
      loadReview:()=>credentialPrivateBytes(file),fullAudit,unrelatedAudit,helper,
      loadStarted:binding=>JSON.parse(credentialPrivateBytes(join(records,`started-${binding}.json`))),
      saveStarted:value=>durableRecord(join(records,`started-${value.binding}.json`),value),
      saveReceipt:value=>{
        const path=join(records,`saved-${value.binding}.json`);
        let old;try{old=JSON.parse(credentialPrivateBytes(path));}catch(e){if(e.code!=='ENOENT')throw e;}
        if(old)assert.deepEqual(old,value);else durableRecord(path,value);return path;
      }})));
  }
}catch{console.error('CLAWBOT_TUNNEL_IMPORT_STOPPED_MAINTENANCE_REMAINS');process.exitCode=1;}
finally{context?.unlock();}
