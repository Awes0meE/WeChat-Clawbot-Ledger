import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLedgerTokenUpdate } from '../../../scripts/mac/ledger-token-operation.mjs';

function fixture(action = 'apply') {
  const trace = [], binding = 'a'.repeat(64), now = 1800000000000;
  const evidence = { version:1, backupManifestSha256:'b'.repeat(64), identitySha256:'c'.repeat(64),
    inputSha256:'d'.repeat(64), unrelatedAudit:{inventory:'unchanged'} };
  const audit = { inventory:'before', databases:{ledger:'ledger-hash',receipts:'receipt-hash'} };
  const review = { ...evidence, binding, approved:true, reviewedAt:new Date(now).toISOString() };
  let started, receipt;
  const args = { action, evidence, manifest:{audit}, now, reviewBytes:Buffer.from(JSON.stringify(review)),
    loadReview: () => args.reviewBytes,
    quiescent: async () => {trace.push('quiescent');return evidence.unrelatedAudit;},
    fullAudit: async () => {trace.push('audit');return audit;},
    saveStarted: async record => {trace.push('started');started=record;},
    loadStarted: async () => {trace.push('load-started');assert.ok(started);return started;},
    helper: async mode => {trace.push(mode);return mode==='inspect'
      ? {status:'CLAWBOT_LEDGER_ROTATION_READY_FOR_REVIEW',binding}
      : {status:'CLAWBOT_LEDGER_TOKENS_SAVED_MAINTENANCE_REQUIRED',binding,unrelatedStatePreserved:true};},
    saveReceipt: async record => {trace.push('receipt');receipt=record;return 'private-receipt';} };
  return {args,trace,review,audit,evidence,binding,getReceipt:()=>receipt,setStarted:record=>{started=record;}};
}
test('writes durable operation before update and leaves maintenance after audited success', async () => {
  const f=fixture(), result=await applyLedgerTokenUpdate(f.args);
  assert.equal(result.maintenanceRequired,true);assert.equal(result.remoteVerified,false);
  assert.ok(f.trace.indexOf('started') < f.trace.indexOf('apply'));
  assert.deepEqual(f.trace.slice(-3),['quiescent','audit','receipt']);
  assert.deepEqual(f.getReceipt().afterAudit.databases,f.audit.databases);
});
test('stale review, changed identity/input/backup and backup mismatch refuse before write', async () => {
  for (const change of [
    f=>{f.args.reviewBytes=Buffer.from(JSON.stringify({...f.review,approved:false}));},
    f=>{f.args.now+=30*60000+1;},
    ...['backupManifestSha256','identitySha256','inputSha256'].map(key=>f=>{f.args.evidence={...f.evidence,[key]:'changed'};}),
    f=>{f.args.fullAudit=async()=>({...f.audit,inventory:'newer-data'});},
    f=>{f.args.loadReview=()=>Buffer.from('changed during inspection');},
    f=>{f.args.quiescent=async()=>{throw Error('running volume consumer');};},
  ]) {
    const f=fixture();change(f);await assert.rejects(applyLedgerTokenUpdate(f.args));
    assert.ok(!f.trace.includes('apply') && !f.trace.includes('receipt'));
  }
});
test('helper failure and post-write data changes retain started evidence and do not save success', async () => {
  for(const phase of ['helper','unrelated','database']) {
    const f=fixture();let wrote=false;
    const original=f.args.helper;
    f.args.helper=async mode=>{const result=await original(mode);if(mode==='apply'){wrote=true;if(phase==='helper')throw Error('interrupted');}return result;};
    if(phase==='unrelated')f.args.quiescent=async()=>wrote?{inventory:'changed'}:f.evidence.unrelatedAudit;
    if(phase==='database')f.args.fullAudit=async()=>wrote?{...f.audit,databases:{ledger:'changed'}}:f.audit;
    await assert.rejects(applyLedgerTokenUpdate(f.args));
    assert.ok(f.trace.includes('started'));assert.equal(f.getReceipt(),undefined);
  }
});
test('resume requires original durable evidence and can finalize a saved pair without rerunning writes', async () => {
  const missing=fixture('resume');await assert.rejects(applyLedgerTokenUpdate(missing.args));
  assert.ok(!missing.trace.includes('resume'));
  const f=fixture('resume');f.setStarted({...f.evidence,binding:f.binding});
  f.args.helper=async mode=>{assert.equal(mode,'resume');return {status:'CLAWBOT_LEDGER_SAVED_PAIR_VERIFIED',readOnlySavedPair:true};};
  const result=await applyLedgerTokenUpdate(f.args);
  assert.equal(result.maintenanceRequired,true);assert.ok(!f.trace.includes('started'));
  const changed=fixture('resume');changed.setStarted({...changed.evidence,binding:'e'.repeat(64)});
  await assert.rejects(applyLedgerTokenUpdate(changed.args));assert.ok(!changed.trace.includes('resume'));
});
