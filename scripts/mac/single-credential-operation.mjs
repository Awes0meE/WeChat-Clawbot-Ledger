import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Caller authenticates backup/maintenance, exact host and stage identities,
// and holds the operation lock. This operation has no service-start ability.
export async function applySingleCredentialUpdate({kind,action,evidence,manifest,reviewBytes,loadReview,fullAudit,unrelatedAudit,
  loadStarted,saveStarted,helper,saveReceipt,now=Date.now()}) {
  assert.ok(['weixin','tunnel'].includes(kind));
  const statuses={weixin:{saved:'CLAWBOT_WEIXIN_AUTH_SAVED_MAINTENANCE_REQUIRED',verified:'CLAWBOT_WEIXIN_SAVED_CREDENTIAL_VERIFIED',
    complete:'CLAWBOT_WEIXIN_IMPORT_SAVED_MAINTENANCE_REQUIRED'},
    tunnel:{saved:'CLAWBOT_TUNNEL_CREDENTIAL_SAVED_MAINTENANCE_REQUIRED',verified:'CLAWBOT_TUNNEL_SAVED_CREDENTIAL_VERIFIED',
      complete:'CLAWBOT_TUNNEL_IMPORT_SAVED_MAINTENANCE_REQUIRED'}}[kind];
  assert.ok(statuses);
  assert.ok(['apply','resume'].includes(action));
  const review=JSON.parse(reviewBytes);
  for(const [key,value] of Object.entries(evidence))assert.deepEqual(review[key],value);
  assert.equal(review.approved,true);assert.equal(review.binding,hash(JSON.stringify(review.helperReview)));
  const operation={...evidence,operationKind:kind,binding:review.binding,reviewSha256:hash(reviewBytes)};
  const fresh=at=>{const age=at-Date.parse(review.reviewedAt);assert.ok(Number.isFinite(age)&&age>=0&&age<=30*60000);};
  assert.deepEqual(await loadReview(),reviewBytes);
  assert.deepEqual(await unrelatedAudit(),review.unrelatedAudit);
  let state=await fullAudit();
  if(action==='apply') {
    fresh(now);assert.deepEqual(state,manifest.audit);
    await saveStarted({...operation,startedAt:new Date(now).toISOString()});
  }else {
    const started=await loadStarted(review.binding);
    for(const [key,value] of Object.entries(operation))assert.deepEqual(started[key],value);
    const at=Date.parse(started.startedAt);assert.ok(Number.isFinite(at)&&at<=now);fresh(at);
  }
  assert.deepEqual(await loadReview(),reviewBytes);assert.deepEqual(await unrelatedAudit(),review.unrelatedAudit);
  state=await fullAudit();
  let unchanged=true;try{assert.deepEqual(state,manifest.audit);}catch{unchanged=false;}
  // A pre-write interruption can retry only from the exact backup state.
  // Any changed state must pass the strictly read-only saved-file verifier.
  if(action==='apply')assert.ok(unchanged);
  const result=await helper(unchanged?'apply':'verify-saved',review.helperReview);
  assert.equal(result.binding,review.binding);assert.equal(result.unrelatedStatePreserved,true);
  assert.equal(result.remoteVerified,false);assert.equal(result.maintenanceRequired,true);
  if(unchanged)assert.equal(result.status,statuses.saved);
  else assert.ok(result.status===statuses.verified&&result.readOnlySavedCredential===true);
  assert.deepEqual(await loadReview(),reviewBytes);assert.deepEqual(await unrelatedAudit(),review.unrelatedAudit);
  const afterAudit=await fullAudit();assert.deepEqual(afterAudit.databases,manifest.audit.databases);
  const receipt=await saveReceipt({...operation,afterAudit,remoteVerified:false,maintenanceRequired:true});
  return {status:statuses.complete,receipt,remoteVerified:false,maintenanceRequired:true};
}
