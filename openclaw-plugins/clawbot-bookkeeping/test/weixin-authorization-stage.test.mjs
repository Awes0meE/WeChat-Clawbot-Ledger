import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureWeixinLogin, inspectWeixinLoginCandidate } from '../../../deploy/docker/weixin-login-capture.mjs';
import { validateWeixinStage, weixinStageArgs, weixinImportArgs } from '../../../scripts/mac/weixin-authorization-stage-policy.mjs';

const identity={accountId:'fixture-account',userId:'fixture-owner',baseUrl:'https://ilinkai.weixin.qq.com'};
function login(overrides={}) {
  const calls=[],saved=[];
  const run=()=>captureWeixinLogin({identity,interactive:true,
    start:async options=>{calls.push(['start',options]);return {qrcodeUrl:'synthetic-qr',sessionKey:'synthetic-session'};},
    display:async qr=>{calls.push(['display',qr]);},
    wait:async options=>{calls.push(['wait',options]);return {connected:true,accountId:'RAW_ACCOUNT',userId:identity.userId,baseUrl:identity.baseUrl,botToken:'synthetic-new'};},
    normalize:raw=>{assert.equal(raw,'RAW_ACCOUNT');return identity.accountId;},
    save:async value=>saved.push(value),...overrides});
  return {run,calls,saved};
}
test('QR protocol stages exactly one normalized same-owner candidate without returning credentials',async()=>{
  const fixture=login(),result=await fixture.run();
  assert.deepEqual(result,{status:'CLAWBOT_WEIXIN_LOGIN_STAGED_SAME_IDENTITY',productionChanged:false});
  assert.equal(fixture.saved.length,1);assert.equal(fixture.saved[0].token,'synthetic-new');
  assert.equal(fixture.saved[0].accountId,identity.accountId);
  assert.deepEqual(fixture.calls.map(x=>x[0]),['start','display','wait']);
  assert.deepEqual(fixture.calls[0][1],{accountId:identity.accountId,apiBaseUrl:identity.baseUrl,botType:'3',verbose:false});
  assert.equal(fixture.calls[2][1].sessionKey,'synthetic-session');assert.equal(fixture.calls[2][1].timeoutMs,480000);
});
test('Same owner with a changed bot or endpoint is retained only for identity review',async()=>{
  for(const difference of [{accountId:'different-account'},{baseUrl:'https://different.example'}]) {
    const fixture=login({normalize:x=>x,wait:async()=>({connected:true,...identity,botToken:'synthetic-new',...difference})});
    assert.equal((await fixture.run()).status,'CLAWBOT_WEIXIN_LOGIN_STAGED_REQUIRES_IDENTITY_REVIEW');
    assert.equal(fixture.saved.length,1);
  }
});
test('Different owner, incomplete login and invalid credentials never reach the save callback',async()=>{
  for(const difference of [{userId:'wrong-owner'},{userId:undefined},{connected:false},{botToken:''},{botToken:'bad\nvalue'},
    {baseUrl:'http://insecure.example'},{baseUrl:'https://user:password@example.com'},{accountId:'../escape'}]) {
    const fixture=login({normalize:x=>x,wait:async()=>({connected:true,...identity,botToken:'synthetic-new',...difference})});
    await assert.rejects(fixture.run());assert.equal(fixture.saved.length,0);
  }
  const fixture=login({wait:async()=>{throw new Error('cancelled');}});
  await assert.rejects(fixture.run());assert.equal(fixture.saved.length,0);
});
test('Non-interactive or unbound owner refuses before requesting QR; already-connected does not manufacture credentials',async()=>{
  for(const change of [{interactive:false},{identity:{...identity,userId:undefined}}]) {
    const fixture=login(change);await assert.rejects(fixture.run());assert.deepEqual(fixture.calls,[]);
  }
  const fixture=login({wait:async()=>({connected:true,alreadyConnected:true})});
  assert.equal((await fixture.run()).status,'CLAWBOT_WEIXIN_LOGIN_NO_NEW_CREDENTIAL');assert.equal(fixture.saved.length,0);
  assert.throws(()=>inspectWeixinLoginCandidate({...identity,token:'synthetic',userId:undefined},{...identity,userId:undefined}));
});
const stage={version:1,kind:'weixin-authorization-stage',id:'11111111-2222-4333-8444-555555555555',
  volume:'clawbot-weixin-auth-stage-11111111-2222-4333-8444-555555555555',sourceCommit:'a'.repeat(40),runtimeImage:'sha256:'+'b'.repeat(64),
  maintenanceSha256:'c'.repeat(64),backupManifestSha256:'d'.repeat(64),identitySha256:'e'.repeat(64),createdAt:'2026-09-08T00:00:00Z'};
test('Login has only the isolated stage volume; inspection is offline and read-only',()=>{
  for(const action of ['login','inspect']) {
    const args=weixinStageArgs(stage,action),values=flag=>args.flatMap((x,i)=>x===flag?[args[i+1]]:[]);
    assert.deepEqual(values('--mount'),[`type=volume,src=${stage.volume},dst=/weixin-authorization${action==='inspect'?',readonly':''}`]);
    assert.deepEqual(values('--network'),[action==='login'?'bridge':'none']);
    assert.deepEqual(values('--log-driver'),['none']);assert.deepEqual(values('--user'),['1000:1000']);
    assert.equal(args.includes('-it'),action==='login');assert.ok(args.includes('--read-only'));
    assert.ok(!args.some(x=>x==='--publish'||x==='-p'||x.includes('docker.sock')));
    assert.ok(values('--env').includes('OPENCLAW_STATE_DIR=/tmp/weixin-login-state'));
  }
  for(const change of [{volume:'clawbot-production_openclaw-state'},{runtimeImage:'openclaw:latest'},{identitySha256:null},{id:'../escape'}])
    assert.throws(()=>validateWeixinStage({...stage,...change}));
});
test('Captured host login refuses before looking up a production host or starting OAuth',()=>{
  const cli=new URL('../../../scripts/mac/weixin-authorization-stage.mjs',import.meta.url);
  const result=spawnSync(process.execPath,[fileURLToPath(cli),'login','/nonexistent-host','/nonexistent-backup','/nonexistent-stage'],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,1);assert.equal(result.stdout,'');
  assert.equal(result.stderr.trim(),'CLAWBOT_WEIXIN_STAGE_STOPPED_NO_IMPORT_MAINTENANCE_REMAINS');
});
test('Import mounts only the target OpenClaw state writable, and receipt recovery mounts every source read-only',()=>{
  const spec={project:'clawbot-production',sourceCommit:stage.sourceCommit,services:{openclaw:{image:stage.runtimeImage}}};
  for(const action of ['inspect','apply','verify-saved']) {
    const args=weixinImportArgs(stage,spec,action),values=flag=>args.flatMap((x,i)=>x===flag?[args[i+1]]:[]);
    const mounts=values('--mount');assert.equal(mounts.length,3);
    assert.ok(mounts[0].includes(stage.volume)&&mounts[0].endsWith(',readonly'));
    assert.ok(mounts[1].includes('clawbot-production_openclaw-state'));
    assert.equal(mounts[1].endsWith(',readonly'),action!=='apply');
    assert.ok(mounts[2].includes('clawbot-production_runtime-config')&&mounts[2].endsWith(',readonly'));
    assert.deepEqual(values('--network'),['none']);assert.deepEqual(values('--log-driver'),['none']);
    assert.ok(!args.includes('-it'));assert.ok(!mounts.some(x=>x.includes('secrets')||x.includes('ledger-data')||x.includes('receipts')));
  }
  assert.throws(()=>weixinImportArgs(stage,{...spec,sourceCommit:'0'.repeat(40)},'apply'));
});
