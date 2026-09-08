// Synthetic fixtures only. Run in an offline disposable container with the
// three fixed roots backed by tmpfs; never mount a live OpenClaw state here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { captureWeixinLogin } from './weixin-login-capture.mjs';
import { MIGRATION_ROLES } from './migration-format.mjs';
const root='/weixin-authorization',configRoot='/weixin-target-config',stateRoot='/weixin-target-state';
for(const path of [root,configRoot,stateRoot])assert.deepEqual(fs.readdirSync(path),[]);
const id='11111111-2222-4333-8444-555555555555';
const identity={accountId:'fixture-account',userId:'fixture-owner',baseUrl:'https://ilinkai.weixin.qq.com'};
const agent=JSON.parse(fs.readFileSync('/fixture-config/weixin-bookkeeper-agent.example.json')).find(x=>x.path==='agents.entries.bookkeeper').value;
Object.assign(agent,{workspace:'/opt/clawbot/workspace',bootstrapMaxChars:8000,bootstrapTotalMaxChars:16000});
const config={agents:{entries:{bookkeeper:agent}},commands:{ownerAllowFrom:['openclaw-weixin:'+identity.userId]},
  bindings:[{type:'route',agentId:'bookkeeper',match:{channel:'openclaw-weixin',accountId:identity.accountId},session:{dmScope:'per-account-channel-peer'}}],
  gateway:{mode:'local',bind:'loopback',port:18789,auth:{mode:'token',token:'synthetic-gateway-'.repeat(4)}},
  channels:{'openclaw-weixin':{enabled:true}},plugins:{allow:['clawbot-bookkeeping','openclaw-weixin','codex'],
    load:{paths:['/opt/clawbot/plugins/clawbot-bookkeeping','/opt/clawbot/plugins/openclaw-weixin-stable-id']},entries:{
      'clawbot-bookkeeping':{enabled:true,hooks:{allowConversationAccess:true,allowPromptInjection:true},config:{
        deploymentProfile:'production',serverBaseUrl:'http://127.0.0.1:8888',tokenPath:'/var/lib/clawbot/secrets/http-token',
        mcpTokenPath:'/var/lib/clawbot/secrets/mcp-token',stateDbPath:'/var/lib/clawbot/receipts/message-receipts.sqlite',
        accountName:'日常支出',ledgerDisplayName:'日常账本'}},'openclaw-weixin':{enabled:true},
      codex:{enabled:true,config:{codexDynamicToolsLoading:'direct'}}}},hooks:{internal:{enabled:true,entries:{'session-memory':{enabled:true}}}}};
const put=(path,value)=>fs.writeFileSync(path,JSON.stringify(value),{mode:0o600});
put(configRoot+'/openclaw.json',config);
fs.mkdirSync(stateRoot+'/openclaw-weixin/accounts',{recursive:true,mode:0o700});
put(stateRoot+'/openclaw-weixin/accounts/fixture-account.json',{...identity,token:'synthetic-old',future:{retained:true}});
put(stateRoot+'/openclaw-weixin/accounts.json',['fixture-account','other-account']);
put(stateRoot+'/openclaw-weixin/accounts/fixture-account.sync.json',{cursor:'synthetic-cursor'});
function inventory(path) {
  return fs.readdirSync(path).sort().map(name=>{const file=path+'/'+name,s=fs.lstatSync(file);
    return [name,s.mode,s.isDirectory()?inventory(file):createHash('sha256').update(fs.readFileSync(file)).digest('hex')];});
}
const original={config:inventory(configRoot),state:inventory(stateRoot)};
function helper(action,hash,fails=false) {
  const r=spawnSync(process.execPath,[new URL('./weixin-authorization-stage.mjs',import.meta.url).pathname,action,id,...(hash?[hash]:[])],
    {encoding:'utf8',timeout:20000});
  assert.ok(!r.error,'Stage helper did not complete');assert.equal(r.status,fails?1:0,r.stderr);
  if(fails){assert.equal(r.stdout,'');assert.equal(r.stderr.trim(),'CLAWBOT_WEIXIN_STAGE_REFUSED_NO_IMPORT');return;}
  return JSON.parse(r.stdout);
}
const initialized=helper('initialize');assert.equal(initialized.status,'CLAWBOT_WEIXIN_STAGE_INITIALIZED');
const hash=initialized.identitySha256;
assert.deepEqual(fs.readdirSync(root).sort(),['identity.json','initialized.json']);
assert.deepEqual(JSON.parse(fs.readFileSync(root+'/identity.json')),identity);
helper('initialize',undefined,true);
assert.equal(helper('inspect',hash).status,'CLAWBOT_WEIXIN_LOGIN_REQUIRED');
helper('inspect','0'.repeat(64),true);helper('login',hash,true);
assert.deepEqual(fs.readdirSync(root).sort(),['identity.json','initialized.json']);

// Exercise the actual pinned official QR protocol and SDK normalizer with
// synthetic HTTP responses. The container network is additionally disabled.
const upstream='/opt/clawbot/plugins/openclaw-weixin-stable-id';
const {startWeixinLoginWithQr,waitForWeixinLogin,displayQRCode}=await import(upstream+'/dist/src/auth/login-qr.js');
const {normalizeAccountId}=await import(upstream+'/node_modules/openclaw/dist/plugin-sdk/account-id.js');
assert.equal(typeof displayQRCode,'function');
let calls=0,displayed=0;
globalThis.fetch=async(url,options)=>{
  calls++;const parsed=new URL(url);
  assert.equal(parsed.origin,identity.baseUrl);
  if(parsed.pathname==='/ilink/bot/get_bot_qrcode') {
    assert.equal(parsed.searchParams.get('bot_type'),'3');assert.equal(options.method,'POST');
    assert.deepEqual(JSON.parse(options.body).local_token_list,[]);
    return new Response(JSON.stringify({qrcode:'synthetic-code',qrcode_img_content:'synthetic-qr'}),{status:200});
  }
  assert.equal(parsed.pathname,'/ilink/bot/get_qrcode_status');
  assert.equal(parsed.searchParams.get('qrcode'),'synthetic-code');
  return new Response(JSON.stringify({status:'confirmed',ilink_bot_id:'fixture-account',ilink_user_id:identity.userId,
    bot_token:'synthetic-new',baseurl:identity.baseUrl}),{status:200});
};
const staged=await captureWeixinLogin({identity,interactive:true,start:startWeixinLoginWithQr,wait:waitForWeixinLogin,
  display:async qr=>{assert.equal(qr,'synthetic-qr');displayed++;},normalize:normalizeAccountId,save:c=>put(root+'/candidate.json',c)});
assert.equal(staged.status,'CLAWBOT_WEIXIN_LOGIN_STAGED_SAME_IDENTITY');assert.equal(calls,2);assert.equal(displayed,1);
assert.equal(helper('inspect',hash).status,staged.status);
const candidate=JSON.parse(fs.readFileSync(root+'/candidate.json'));
assert.equal(fs.lstatSync(root+'/candidate.json').mode&0o777,0o600);
put(root+'/candidate.json',{...candidate,accountId:'different-account'});
assert.equal(helper('inspect',hash).status,'CLAWBOT_WEIXIN_LOGIN_STAGED_REQUIRES_IDENTITY_REVIEW');
put(root+'/candidate.json',{...candidate,userId:'different-owner'});helper('inspect',hash,true);
assert.deepEqual({config:inventory(configRoot),state:inventory(stateRoot)},original);
assert.ok(!fs.existsSync('/tmp/weixin-login-state/openclaw-weixin/accounts.json'));
assert.ok(!fs.existsSync('/tmp/weixin-login-state/openclaw.json'));

const target='/var/lib/clawbot/openclaw',runtime='/run/clawbot-runtime';
for(const path of [target,runtime,'/state'])assert.deepEqual(fs.readdirSync(path),[]);
fs.cpSync(stateRoot,target,{recursive:true});fs.copyFileSync(configRoot+'/openclaw.json',runtime+'/openclaw.json');
put(root+'/candidate.json',candidate);
const sourceBefore=inventory(root),runtimeBefore=inventory(runtime),targetBefore=inventory(target);
function importer(action,review,fails=false) {
  const r=spawnSync(process.execPath,[new URL('./import-weixin-authorization.mjs',import.meta.url).pathname,action],
    {input:JSON.stringify({stageId:id,identitySha256:hash,review}),encoding:'utf8',timeout:20000});
  assert.ok(!r.error);assert.equal(r.status,fails?1:0,r.stderr);
  if(fails){assert.equal(r.stdout,'');assert.equal(r.stderr.trim(),'CLAWBOT_WEIXIN_IMPORT_REFUSED_MAINTENANCE_REQUIRED');return;}
  return JSON.parse(r.stdout);
}
const inspected=importer('inspect');assert.equal(inspected.status,'CLAWBOT_WEIXIN_AUTH_RENEWAL_READY_FOR_REVIEW');
assert.deepEqual(inventory(target),targetBefore);importer('verify-saved',inspected.review,true);
put(root+'/candidate.json',{...candidate,token:'changed-after-review'});importer('apply',inspected.review,true);
put(root+'/candidate.json',candidate);
put(runtime+'/openclaw.json',{...config,future:'changed'});importer('apply',inspected.review,true);
put(runtime+'/openclaw.json',config);assert.deepEqual(inventory(target),targetBefore);

for(const role of MIGRATION_ROLES)fs.mkdirSync('/state/'+role,{mode:0o700});
fs.cpSync(target,'/state/openclaw-state',{recursive:true});
fs.mkdirSync('/state/ledger-data/data',{mode:0o700});
for(const path of ['/state/ledger-data/data/ezbookkeeping.db','/state/receipts/message-receipts.sqlite']) {
  const db=new DatabaseSync(path);db.exec('CREATE TABLE future_records(id INTEGER,value BLOB)');
  db.prepare('INSERT INTO future_records VALUES(?,?)').run(9007199254740993n,Buffer.from([0,255,1]));db.close();
}
function audit(flag) {
  const r=spawnSync(process.execPath,[new URL('./nine-volume-audit.mjs',import.meta.url).pathname,...(flag?[flag]:[])],{encoding:'utf8',timeout:20000});
  assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
const beforeAudit=audit(),otherRoles=audit('--exclude-openclaw-state');
const applied=importer('apply',inspected.review);assert.equal(applied.status,'CLAWBOT_WEIXIN_AUTH_SAVED_MAINTENANCE_REQUIRED');
assert.equal(applied.binding,inspected.binding);assert.equal(applied.unrelatedStatePreserved,true);
const after=inventory(target);
for(let attempt=0;attempt<2;attempt++) {
  const verified=importer('verify-saved',inspected.review);
  assert.equal(verified.status,'CLAWBOT_WEIXIN_SAVED_CREDENTIAL_VERIFIED');assert.equal(verified.readOnlySavedCredential,true);
  assert.equal(verified.binding,inspected.binding);assert.deepEqual(inventory(target),after);
}
importer('apply',inspected.review,true);
fs.cpSync(target,'/state/openclaw-state',{recursive:true});
assert.notEqual(audit().inventorySha256,beforeAudit.inventorySha256);
assert.deepEqual(audit('--exclude-openclaw-state'),otherRoles);
fs.writeFileSync('/state/codex-state/unknown','unexpected');
assert.notEqual(audit('--exclude-openclaw-state').inventorySha256,otherRoles.inventorySha256);
fs.unlinkSync('/state/codex-state/unknown');
const db=new DatabaseSync('/state/ledger-data/data/ezbookkeeping.db');
db.exec("UPDATE future_records SET value = X'0102'");db.close();
assert.notDeepEqual(audit('--exclude-openclaw-state'),otherRoles);
put(target+'/openclaw-weixin/accounts/fixture-account.sync.json',{cursor:'unexpected'});
importer('verify-saved',inspected.review,true);
assert.deepEqual(inventory(root),sourceBefore);assert.deepEqual(inventory(runtime),runtimeBefore);
console.log('CLAWBOT_WEIXIN_STAGE_AND_IMPORT_OFFLINE_VERIFIED');
