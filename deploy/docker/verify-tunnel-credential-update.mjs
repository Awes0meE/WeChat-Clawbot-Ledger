import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalTunnelConfig,readTunnelActivation } from '../guard/tunnel-policy.mjs';
import { MIGRATION_ROLES } from './migration-format.mjs';
assert.equal(process.env.CLAWBOT_TUNNEL_CREDENTIAL_REHEARSAL,'1');
for(const path of ['/run/clawbot-tunnel','/run/clawbot-guard','/state'])assert.deepEqual(fs.readdirSync(path),[]);
const hash=value=>createHash('sha256').update(value).digest('hex');
const target={sourceCommit:'a'.repeat(40),sourceSnapshotSha256:'b'.repeat(64),cutoverId:'11111111-2222-3333-4444-555555555555'};
const config=JSON.stringify(canonicalTunnelConfig(target.cutoverId));
const policy={profile:'production',tunnelId:target.cutoverId,...target,tunnelConfigSha256:hash(config)};
const activation={version:1,project:'clawbot-production',...target,windowsReceiverStopped:true,windowsTunnelStopped:true,windowsLedgerStopped:true};
const original={TunnelID:target.cutoverId,AccountTag:'c'.repeat(32),TunnelSecret:Buffer.alloc(32,1).toString('base64'),future:{kept:'metadata'}};
const candidateText=JSON.stringify({...original,TunnelSecret:Buffer.alloc(32,2).toString('base64')});
function put(path,value){fs.writeFileSync(path,typeof value==='string'?value:JSON.stringify(value),{mode:0o400});}
put('/run/clawbot-tunnel/config.json',config);put('/run/clawbot-tunnel/credentials.json',original);
put('/run/clawbot-tunnel/unknown.txt','preserve');put('/run/clawbot-guard/policy.json',policy);put('/run/clawbot-guard/activation.json',activation);
readTunnelActivation(policy);
function helper(action,review,input=candidateText,fails=false) {
  const r=spawnSync(process.execPath,[new URL('./import-tunnel-credential.mjs',import.meta.url).pathname,action],
    {input:JSON.stringify({target,candidateText:input,review}),encoding:'utf8',timeout:20000});
  assert.ok(!r.error);assert.equal(r.status,fails?1:0,r.stderr);
  if(fails){assert.equal(r.stdout,'');assert.equal(r.stderr.trim(),'CLAWBOT_TUNNEL_CREDENTIAL_UPDATE_REFUSED_MAINTENANCE_REQUIRED');return;}
  return JSON.parse(r.stdout);
}
for(const role of MIGRATION_ROLES)fs.mkdirSync('/state/'+role,{mode:0o700});
fs.cpSync('/run/clawbot-tunnel','/state/tunnel-config',{recursive:true});fs.cpSync('/run/clawbot-guard','/state/guard-config',{recursive:true});
fs.mkdirSync('/state/ledger-data/data',{mode:0o700});
for(const path of ['/state/ledger-data/data/ezbookkeeping.db','/state/receipts/message-receipts.sqlite']) {
  const db=new DatabaseSync(path);db.exec('CREATE TABLE future_records(id INTEGER,value BLOB)');
  db.prepare('INSERT INTO future_records VALUES(?,?)').run(9007199254740993n,Buffer.from([0,255,1]));db.close();
}
function audit(flag) {
  const r=spawnSync(process.execPath,[new URL('./nine-volume-audit.mjs',import.meta.url).pathname,...(flag?[flag]:[])],{encoding:'utf8',timeout:20000});
  assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
const before=audit(),other=audit('--exclude-tunnel-credential');assert.equal(other.scope,'excluding-tunnel-credential');
const inspection=helper('inspect'),old=fs.readFileSync('/run/clawbot-tunnel/credentials.json');
helper('verify-saved',inspection.review,candidateText,true);
helper('apply',inspection.review,JSON.stringify({...JSON.parse(candidateText),AccountTag:'d'.repeat(32)}),true);
assert.ok(fs.readFileSync('/run/clawbot-tunnel/credentials.json').equals(old));
const result=helper('apply',inspection.review);assert.equal(result.status,'CLAWBOT_TUNNEL_CREDENTIAL_SAVED_MAINTENANCE_REQUIRED');
assert.equal(result.binding,inspection.binding);assert.equal(result.remoteVerified,false);readTunnelActivation(policy);
const saved=fs.readFileSync('/run/clawbot-tunnel/credentials.json');
assert.deepEqual(JSON.parse(saved),{...original,TunnelSecret:JSON.parse(candidateText).TunnelSecret});
for(let i=0;i<2;i++)assert.equal(helper('verify-saved',inspection.review).readOnlySavedCredential,true);
assert.ok(fs.readFileSync('/run/clawbot-tunnel/credentials.json').equals(saved));
const cli=spawnSync('/usr/local/bin/cloudflared',['tunnel','--config','/run/clawbot-tunnel/config.json','ingress','validate'],{encoding:'utf8',timeout:10000});
assert.equal(cli.status,0,'Fixed cloudflared refused the preserved canonical ingress');
assert.ok(fs.readFileSync('/state/tunnel-config/credentials.json').equals(old));
fs.unlinkSync('/state/tunnel-config/credentials.json');
fs.copyFileSync('/run/clawbot-tunnel/credentials.json','/state/tunnel-config/credentials.json');
assert.notEqual(audit().inventorySha256,before.inventorySha256);assert.deepEqual(audit('--exclude-tunnel-credential'),other);
put('/state/tunnel-config/credentials.json.renewal-fixture.tmp','incomplete');
assert.notEqual(audit('--exclude-tunnel-credential').inventorySha256,other.inventorySha256);
fs.unlinkSync('/state/tunnel-config/credentials.json.renewal-fixture.tmp');
fs.chmodSync('/state/tunnel-config/unknown.txt',0o600);fs.writeFileSync('/state/tunnel-config/unknown.txt','changed');
assert.notEqual(audit('--exclude-tunnel-credential').inventorySha256,other.inventorySha256);
const db=new DatabaseSync('/state/receipts/message-receipts.sqlite');db.exec("UPDATE future_records SET value = X'0304'");db.close();
assert.notDeepEqual(audit('--exclude-tunnel-credential').databases,other.databases);
assert.ok(fs.readFileSync('/run/clawbot-tunnel/config.json').equals(Buffer.from(config)));
console.log('CLAWBOT_TUNNEL_CREDENTIAL_IMPORT_AND_EXACT_AUDIT_VERIFIED_OFFLINE');
