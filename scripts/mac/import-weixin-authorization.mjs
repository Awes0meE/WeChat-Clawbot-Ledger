import assert from 'node:assert/strict';
import { mkdirSync,lstatSync,realpathSync,openSync,writeFileSync,fsyncSync,closeSync } from 'node:fs';
import { join,resolve,dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { operationsRoot } from './operation-lock.mjs';
import { credentialMaintenanceContext,credentialPrivateBytes,credentialHash } from './credential-maintenance-context.mjs';
import { validateWeixinStage,weixinImportArgs } from './weixin-authorization-stage-policy.mjs';
import { auditManagedState } from './managed-state-audit.mjs';
import { applyWeixinImport } from './weixin-import-operation.mjs';
function durableRecord(path,value) {
  const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}
  const parent=openSync(dirname(path),'r');try{fsyncSync(parent);}finally{closeSync(parent);}
}
let context;
try {
  const [action,host,backup,stageArg,reviewArg]=process.argv.slice(2);
  assert.ok(['prepare','apply','resume'].includes(action)&&host&&backup&&stageArg&&process.argv.length===(action==='prepare'?6:7));
  context=await credentialMaintenanceContext(host,backup,'weixin-authorization-import',{allowChangedState:action==='resume'});
  const {spec,driver,manifest}=context,stageFile=resolve(stageArg),stageBytes=credentialPrivateBytes(stageFile);
  const stage=validateWeixinStage(JSON.parse(stageBytes));
  assert.equal(stageFile,join(operationsRoot,'weixin-authorization-stages',`${stage.id}.json`));
  for(const [key,value] of Object.entries(context.evidence))assert.deepEqual(stage[key],value);
  const records=join(operationsRoot,'weixin-authorization-imports');mkdirSync(records,{recursive:true,mode:0o700});
  const stat=lstatSync(records);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===process.getuid()
    &&!(stat.mode&0o077)&&realpathSync(records)===records);
  const evidence={version:1,...context.evidence,stageId:stage.id,stageReceiptSha256:credentialHash(stageBytes)};
  async function fullAudit() {
    assert.ok(credentialPrivateBytes(stageFile).equals(stageBytes));
    const volume=JSON.parse(await driver.run(['volume','inspect',stage.volume]))[0];
    assert.ok(volume.Name===stage.volume&&volume.Driver==='local'&&!Object.keys(volume.Options??{}).length
      &&volume.Labels?.['clawbot.purpose']==='weixin-authorization-stage'&&volume.Labels['clawbot.stage']===stage.id
      &&!volume.Labels['clawbot.project']&&!volume.Labels['clawbot.cutover']);
    assert.equal(await driver.run(['ps','-q','--filter',`volume=${stage.volume}`]),'');
    return await context.assertQuiescent();
  }
  async function unrelatedAudit() {
    await fullAudit();
    // The internal importer separately proves preservation of every OpenClaw
    // file/field except the exact token and savedAt. Audit the other eight roles.
    const audit=await auditManagedState(spec,driver,{excludeOpenclaw:true});
    assert.equal(audit.scope,'excluding-openclaw-state');return audit;
  }
  async function helper(mode,review) {
    const r=spawnSync('/Applications/Docker.app/Contents/Resources/bin/docker',weixinImportArgs(stage,spec,mode),
      {input:JSON.stringify({stageId:stage.id,identitySha256:stage.identitySha256,review}),encoding:'utf8',timeout:120000,maxBuffer:65536});
    assert.equal(r.status,0);return JSON.parse(r.stdout);
  }
  if(action==='prepare') {
    assert.deepEqual(await fullAudit(),manifest.audit);
    const inspection=await helper('inspect');assert.equal(inspection.status,'CLAWBOT_WEIXIN_AUTH_RENEWAL_READY_FOR_REVIEW');
    assert.equal(inspection.binding,credentialHash(JSON.stringify(inspection.review)));
    const unrelated=await unrelatedAudit();assert.deepEqual(await fullAudit(),manifest.audit);
    const file=join(records,`review-${randomUUID()}.json`);
    durableRecord(file,{...evidence,binding:inspection.binding,helperReview:inspection.review,unrelatedAudit:unrelated,approved:false,reviewedAt:null});
    console.log(JSON.stringify({status:'CLAWBOT_WEIXIN_IMPORT_REVIEW_UNCONFIRMED',file,maintenanceRequired:true}));
  }else {
    const file=resolve(reviewArg);assert.equal(dirname(file),records);
    const bytes=credentialPrivateBytes(file);
    const result=await applyWeixinImport({action,evidence,manifest,reviewBytes:bytes,loadReview:()=>credentialPrivateBytes(file),
      fullAudit,unrelatedAudit,helper,
      loadStarted:binding=>JSON.parse(credentialPrivateBytes(join(records,`started-${binding}.json`))),
      saveStarted:value=>durableRecord(join(records,`started-${value.binding}.json`),value),
      saveReceipt:value=>{
        const path=join(records,`saved-${value.binding}.json`);
        let old;try{old=JSON.parse(credentialPrivateBytes(path));}catch(e){if(e.code!=='ENOENT')throw e;}
        if(old)assert.deepEqual(old,value);else durableRecord(path,value);return path;
      }});
    console.log(JSON.stringify(result));
  }
}catch{console.error('CLAWBOT_WEIXIN_IMPORT_STOPPED_MAINTENANCE_REMAINS');process.exitCode=1;}
finally{context?.unlock();}
