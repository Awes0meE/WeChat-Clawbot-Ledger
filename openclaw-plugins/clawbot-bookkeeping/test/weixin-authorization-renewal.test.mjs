import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { renewWeixinAuthorization } from '../../../deploy/docker/weixin-authorization-renewal.mjs';

const moduleUrl=new URL('../../../deploy/docker/weixin-authorization-renewal.mjs',import.meta.url).href;
const failure={message:'CLAWBOT_WEIXIN_AUTH_RENEWAL_REFUSED_MAINTENANCE_REQUIRED'};
function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'clawbot-weixin-auth-')));
  const accounts=join(root,'openclaw-weixin/accounts');mkdirSync(accounts,{recursive:true,mode:0o700});
  mkdirSync(join(root,'credentials'),{mode:0o700});
  const identity={accountId:'synthetic-im-bot',userId:'synthetic-owner'};
  const candidate={...identity,token:'new-synthetic-token',baseUrl:'https://ilinkai.weixin.qq.com'};
  const original={token:'old-synthetic-token',userId:identity.userId,baseUrl:candidate.baseUrl,savedAt:'2026-01-01T00:00:00.000Z',
    unknown:{futureId:'9007199254740993',keep:['all','fields']}};
  const path=join(accounts,identity.accountId+'.json');
  const put=(relative,value)=>writeFileSync(join(root,relative),JSON.stringify(value),{mode:0o600});
  put('openclaw-weixin/accounts.json',[identity.accountId,'another-im-bot']);
  put('openclaw-weixin/accounts/'+identity.accountId+'.json',original);
  put('openclaw-weixin/accounts/another-im-bot.json',{userId:identity.userId,token:'other-account-token'});
  put('openclaw-weixin/accounts/'+identity.accountId+'.sync.json',{get_updates_buf:'saved-cursor'});
  put('openclaw-weixin/accounts/'+identity.accountId+'.context-tokens.json',{'synthetic-owner':'context-token'});
  put('credentials/openclaw-weixin-'+identity.accountId+'-allowFrom.json',{version:1,allowFrom:[identity.userId]});
  put('openclaw.json',{retained:'configuration'});
  const dbPath=join(root,'unknown.sqlite'),db=new DatabaseSync(dbPath);
  db.exec('CREATE TABLE unknown_records(id INTEGER,value BLOB)');db.prepare('INSERT INTO unknown_records VALUES(?,?)').run(9007199254740993n,Buffer.from([0,255,1]));db.close();
  const databaseHash=()=>createHash('sha256').update(readFileSync(dbPath)).digest('hex');
  return{root,path,identity,candidate,original,accounts,databaseHash,put,options:{root,identity,candidate},clean:()=>rmSync(root,{recursive:true,force:true})};
}
test('renewal changes only the exact account credential and preserves same-owner accounts, cursors and database bytes', { skip: process.platform === 'win32' ? 'Requires POSIX filesystem permissions in the Mac/Linux runtime' : false }, async()=>{
  const f=fixture(),db=f.databaseHash();
  try{
    const before=readFileSync(f.path),inspection=await renewWeixinAuthorization({...f.options,action:'inspect',now:1800000000000});
    assert.ok(readFileSync(f.path).equals(before));
    const result=await renewWeixinAuthorization({...f.options,action:'apply',review:inspection.review,now:1800000000000});
    assert.equal(result.status,'CLAWBOT_WEIXIN_AUTH_SAVED_MAINTENANCE_REQUIRED');assert.equal(result.remoteVerified,false);
    assert.deepEqual(JSON.parse(readFileSync(f.path)),{...f.original,token:f.candidate.token,savedAt:new Date(1800000000000).toISOString()});
    assert.equal(f.databaseHash(),db);
    assert.equal(JSON.parse(readFileSync(join(f.accounts,'another-im-bot.json'))).token,'other-account-token');
    assert.equal(JSON.parse(readFileSync(join(f.accounts,f.identity.accountId+'.sync.json'))).get_updates_buf,'saved-cursor');
    await assert.rejects(renewWeixinAuthorization({...f.options,action:'apply',review:inspection.review}),failure);
  }finally{f.clean();}
});
test('wrong account, owner, endpoint, changed state and unsafe unknown numeric metadata are refused without writes', { skip: process.platform === 'win32' ? 'Requires POSIX filesystem permissions in the Mac/Linux runtime' : false }, async()=>{
  const f=fixture();
  try{
    const before=readFileSync(f.path),inspection=await renewWeixinAuthorization({...f.options,action:'inspect',now:1800000000000});
    for(const override of [{accountId:'different-im-bot'},{userId:'different-owner'},{baseUrl:'https://different.invalid'},{token:'bad\nvalue'}]){
      await assert.rejects(renewWeixinAuthorization({...f.options,candidate:{...f.candidate,...override},action:'apply',review:inspection.review}),failure);
      assert.ok(readFileSync(f.path).equals(before));
    }
    f.put('openclaw-weixin/accounts/'+f.identity.accountId+'.sync.json',{get_updates_buf:'newer-cursor'});
    await assert.rejects(renewWeixinAuthorization({...f.options,action:'apply',review:inspection.review}),failure);
    assert.ok(readFileSync(f.path).equals(before));
    writeFileSync(f.path,before.toString().replace('"unknown":','"unsafe":9007199254740993,"unknown":'));
    const unsafe=readFileSync(f.path);await assert.rejects(renewWeixinAuthorization({...f.options,action:'inspect',now:1800000000000}),failure);
    assert.ok(readFileSync(f.path).equals(unsafe));
  }finally{f.clean();}
});
test('failed atomic replacement cleans only its temporary file and retains the original credential', { skip: process.platform === 'win32' ? 'Requires POSIX filesystem permissions in the Mac/Linux runtime' : false }, async()=>{
  const f=fixture();
  try{
    const before=readFileSync(f.path),inspection=await renewWeixinAuthorization({...f.options,action:'inspect',now:1800000000000});
    const child=spawnSync(process.execPath,['--input-type=module','-e',`
      import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
      fs.renameSync=()=>{throw Error('synthetic rename failure');};syncBuiltinESMExports();
      const{renewWeixinAuthorization}=await import(${JSON.stringify(moduleUrl)});
      try{await renewWeixinAuthorization(${JSON.stringify({...f.options,action:'apply',review:inspection.review})});process.exitCode=2;}
      catch(error){if(error.message!==${JSON.stringify(failure.message)})process.exitCode=3;}
    `],{encoding:'utf8',timeout:10000});
    assert.equal(child.status,0);assert.equal(child.stdout,'');assert.ok(readFileSync(f.path).equals(before));
    assert.ok(readdirSync(f.accounts).every(name=>!name.includes('.renewal-')));
    assert.equal((await renewWeixinAuthorization({...f.options,action:'inspect',now:1800000000000})).binding,inspection.binding);
  }finally{f.clean();}
});
test('a process killed immediately after rename can be verified read-only from the pre-write review', { skip: process.platform === 'win32' ? 'Requires POSIX filesystem permissions in the Mac/Linux runtime' : false }, async()=>{
  const f=fixture(),databaseBefore=f.databaseHash();
  try{
    const inspection=await renewWeixinAuthorization({...f.options,action:'inspect',now:1800000000000});
    await assert.rejects(renewWeixinAuthorization({...f.options,action:'verify-saved',review:inspection.review}),failure);
    const child=spawnSync(process.execPath,['--input-type=module','-e',`
      import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
      const rename=fs.renameSync;fs.renameSync=(...args)=>{rename(...args);process.kill(process.pid,'SIGKILL');};syncBuiltinESMExports();
      const{renewWeixinAuthorization}=await import(${JSON.stringify(moduleUrl)});
      await renewWeixinAuthorization(${JSON.stringify({...f.options,action:'apply',review:inspection.review})});
    `],{encoding:'utf8',timeout:10000});
    assert.equal(child.signal,'SIGKILL');assert.equal(child.status,null);assert.equal(child.stdout,'');
    const saved=readFileSync(f.path),names=readdirSync(f.accounts).sort();
    assert.ok(names.every(name=>!name.includes('.renewal-')));
    for(let pass=0;pass<2;pass++) {
      const result=await renewWeixinAuthorization({...f.options,action:'verify-saved',review:inspection.review});
      assert.equal(result.status,'CLAWBOT_WEIXIN_SAVED_CREDENTIAL_VERIFIED');assert.equal(result.readOnlySavedCredential,true);
      assert.equal(result.remoteVerified,false);assert.equal(result.binding,inspection.binding);
      assert.ok(readFileSync(f.path).equals(saved));assert.equal(f.databaseHash(),databaseBefore);
      assert.deepEqual(readdirSync(f.accounts).sort(),names);
    }
    for(const changes of [{candidate:{...f.candidate,token:'another-token'}},{review:{...inspection.review,savedAt:'2027-01-01T00:00:00.000Z'}},
      {review:{...inspection.review,nextSha256:'0'.repeat(64)}}]) {
      await assert.rejects(renewWeixinAuthorization({...f.options,action:'verify-saved',review:inspection.review,...changes}),failure);
      assert.ok(readFileSync(f.path).equals(saved));
    }
    f.put('openclaw-weixin/accounts/'+f.identity.accountId+'.sync.json',{get_updates_buf:'changed-after-save'});
    await assert.rejects(renewWeixinAuthorization({...f.options,action:'verify-saved',review:inspection.review}),failure);
    assert.ok(readFileSync(f.path).equals(saved));
  }finally{f.clean();}
});
