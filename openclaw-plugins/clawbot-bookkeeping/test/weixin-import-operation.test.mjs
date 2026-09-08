import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyWeixinImport } from '../../../scripts/mac/weixin-import-operation.mjs';
import { applySingleCredentialUpdate } from '../../../scripts/mac/single-credential-operation.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
function fixture(kind='weixin') {
  const now=1800000000000,evidence={version:1,sourceCommit:'a'.repeat(40),stageId:'fixture-stage'};
  const before={inventory:'before',databases:{ledger:'ledger',receipts:'receipts'}},after={...before,inventory:'after'};
  const unrelated={scope:'excluding-openclaw-state',inventory:'eight-roles'};
  const helperReview={renewal:{binding:'b'.repeat(64)}},binding=hash(JSON.stringify(helperReview));
  const review={...evidence,binding,helperReview,unrelatedAudit:unrelated,approved:true,reviewedAt:new Date(now).toISOString()};
  const f={state:before,before,after,unrelated,review,started:null,receipts:[],calls:[]};
  const bytes=Buffer.from(JSON.stringify(review));
  f.params={action:'apply',evidence,manifest:{audit:before},reviewBytes:bytes,loadReview:()=>bytes,now,
    fullAudit:()=>f.state,unrelatedAudit:()=>f.unrelated,
    saveStarted:r=>{assert.equal(f.started,null);f.started=r;f.calls.push('started');},
    loadStarted:()=>{assert.ok(f.started);return f.started;},
    helper:(action,r)=>{
      f.calls.push(action);assert.deepEqual(r,helperReview);
      if(action==='apply'){assert.deepEqual(f.state,before);f.state=after;}
      else{assert.equal(action,'verify-saved');assert.deepEqual(f.state,after);}
      const statuses=kind==='weixin'?['CLAWBOT_WEIXIN_AUTH_SAVED_MAINTENANCE_REQUIRED','CLAWBOT_WEIXIN_SAVED_CREDENTIAL_VERIFIED']:
        ['CLAWBOT_TUNNEL_CREDENTIAL_SAVED_MAINTENANCE_REQUIRED','CLAWBOT_TUNNEL_SAVED_CREDENTIAL_VERIFIED'];
      return {status:statuses[action==='apply'?0:1],
        binding,unrelatedStatePreserved:true,readOnlySavedCredential:action==='verify-saved',remoteVerified:false,maintenanceRequired:true};
    },saveReceipt:r=>{f.receipts.push(r);return 'private-receipt';}};
  return f;
}
test('Reviewed import persists its operation before writing and leaves maintenance required',async()=>{
  const f=fixture(),result=await applyWeixinImport(f.params);
  assert.deepEqual(f.calls,['started','apply']);assert.equal(result.maintenanceRequired,true);assert.equal(result.remoteVerified,false);
  assert.equal(f.receipts.length,1);assert.deepEqual(f.receipts[0].afterAudit,f.after);
});
test('Tunnel uses the same durable receipt path, but cannot resume an operation recorded for Weixin',async()=>{
  const f=fixture('tunnel');let fail=true;
  const save=f.params.saveReceipt;f.params.saveReceipt=r=>{if(fail)throw Error('receipt failure');return save(r);};
  await assert.rejects(applySingleCredentialUpdate({...f.params,kind:'tunnel'}));
  assert.equal(f.started.operationKind,'tunnel');assert.deepEqual(f.state,f.after);
  fail=false;
  await assert.rejects(applyWeixinImport({...f.params,action:'resume'}));assert.deepEqual(f.calls,['started','apply']);
  const result=await applySingleCredentialUpdate({...f.params,kind:'tunnel',action:'resume'});
  assert.equal(result.status,'CLAWBOT_TUNNEL_IMPORT_SAVED_MAINTENANCE_REQUIRED');assert.equal(result.maintenanceRequired,true);
  assert.deepEqual(f.calls,['started','apply','verify-saved']);assert.equal(f.receipts.length,1);
});
test('Wrong evidence, unconfirmed or expired review, changed review and unrelated state refuse before writing',async()=>{
  for(const change of [f=>{f.params.evidence.sourceCommit='changed';},f=>{f.review.approved=false;},
    f=>{f.params.now+=31*60000;},f=>{f.params.loadReview=()=>Buffer.from('changed');},
    f=>{f.unrelated={...f.unrelated,inventory:'changed'};},f=>{f.state=f.after;}]) {
    const f=fixture();change(f);
    if(f.review.approved===false){f.params.reviewBytes=Buffer.from(JSON.stringify(f.review));f.params.loadReview=()=>f.params.reviewBytes;}
    await assert.rejects(applyWeixinImport(f.params));assert.deepEqual(f.calls,[]);assert.equal(f.receipts.length,0);
  }
});
test('Receipt gap after a saved credential resumes read-only using the original persisted approval',async()=>{
  const f=fixture();let fail=true;
  const save=f.params.saveReceipt;f.params.saveReceipt=r=>{if(fail)throw Error('synthetic receipt failure');return save(r);};
  await assert.rejects(applyWeixinImport(f.params));assert.deepEqual(f.state,f.after);assert.ok(f.started);
  fail=false;
  await applyWeixinImport({...f.params,action:'resume',now:f.params.now+24*3600000});
  assert.deepEqual(f.calls,['started','apply','verify-saved']);assert.equal(f.receipts.length,1);
  assert.deepEqual(f.state,f.after);
});
test('Pre-write interruption retries only from the exact backup, and resume requires a matching started record',async()=>{
  const f=fixture(),helper=f.params.helper;
  await assert.rejects(applyWeixinImport({...f.params,action:'resume'}));assert.deepEqual(f.calls,[]);
  await assert.rejects(applyWeixinImport({...f.params,helper:()=>{throw Error('interrupted before write');}}));
  assert.deepEqual(f.state,f.before);assert.ok(f.started);
  await applyWeixinImport({...f.params,action:'resume',helper});assert.deepEqual(f.calls,['started','apply']);
  f.started.reviewSha256='0'.repeat(64);
  await assert.rejects(applyWeixinImport({...f.params,action:'resume'}));assert.deepEqual(f.calls,['started','apply']);
});
test('Unexpected changes after writing never become a successful receipt or an unreviewed retry',async()=>{
  const f=fixture(),helper=f.params.helper;
  await assert.rejects(applyWeixinImport({...f.params,helper:(...args)=>{
    const result=helper(...args);f.unrelated={...f.unrelated,inventory:'unexpected-change'};return result;
  }}));
  assert.equal(f.receipts.length,0);
  await assert.rejects(applyWeixinImport({...f.params,action:'resume'}));assert.deepEqual(f.calls,['started','apply']);
  f.unrelated=f.review.unrelatedAudit;f.state={...f.after,inventory:'unrecognized-account-file'};
  await assert.rejects(applyWeixinImport({...f.params,action:'resume'}));
  assert.equal(f.calls.at(-1),'verify-saved');assert.equal(f.receipts.length,0);
});
