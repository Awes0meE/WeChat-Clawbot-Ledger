import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync, realpathSync, readlinkSync, createReadStream,
  openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const fail='CLAWBOT_WEIXIN_AUTH_RENEWAL_REFUSED_MAINTENANCE_REQUIRED';
const hash=value=>createHash('sha256').update(value).digest('hex');
function privateBytes(path) {
  const s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()
    &&s.gid===process.getgid()&&(s.mode&0o777)===0o600&&s.size<=65536&&realpathSync(path)===path);
  return readFileSync(path);
}
function accountObject(bytes) {
  const value=JSON.parse(bytes.toString('utf8'),(_key,value)=>{
    // Credentials normally contain strings. Refuse unknown unsafe numeric
    // metadata rather than silently rounding it during a credential update.
    if(typeof value==='number')assert.ok(Number.isSafeInteger(value));return value;
  });
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value;
}
export function expectedWeixinCredential(existing, candidate, identity, now=Date.now()) {
  try {
    assert.ok(identity&&typeof identity.accountId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(identity.accountId)
      &&typeof identity.userId==='string'&&identity.userId.length>0&&identity.userId.length<=256);
    assert.equal(candidate?.accountId,identity.accountId);assert.equal(candidate.userId,identity.userId);
    assert.equal(existing?.userId,identity.userId);
    assert.equal(candidate.baseUrl,existing.baseUrl||'https://ilinkai.weixin.qq.com');
    const url=new URL(candidate.baseUrl);assert.ok(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash);
    assert.ok(typeof existing.token==='string'&&existing.token.length>0);
    assert.ok(typeof candidate.token==='string'&&candidate.token.length<=16384&&/^[\x21-\x7e]+$/.test(candidate.token));
    assert.notEqual(candidate.token,existing.token);assert.ok(Number.isSafeInteger(now)&&now>0);
    // Preserve every unknown field. Do not invoke upstream stale-account
    // cleanup, index registration or automatic channel/config reload.
    return {...existing,token:candidate.token,savedAt:new Date(now).toISOString()};
  } catch {throw Error(fail);}
}
async function fingerprint(root,accountPath) {
  const entries=[];let bytes=0;
  async function walk(relative) {
    assert.ok(entries.length<100000&&relative.length<4096&&relative.split('/').length<64);
    const path=join(root,relative),s=lstatSync(path);
    if(s.isSocket())return;
    const row={path:relative,mode:s.mode&0o7777,uid:s.uid,gid:s.gid};
    if(s.isDirectory()){
      entries.push({...row,type:'directory'});for(const name of readdirSync(path).sort())await walk(relative?`${relative}/${name}`:name);
    }else if(s.isSymbolicLink())entries.push({...row,type:'symlink',target:readlinkSync(path)});
    else{
      assert.ok(s.isFile()&&s.nlink===1&&s.size<=4*2**30);bytes+=s.size;assert.ok(bytes<=20*2**30);
      if(relative===accountPath){
        const metadata=accountObject(privateBytes(path));delete metadata.token;delete metadata.savedAt;
        entries.push({...row,type:'account',hash:hash(JSON.stringify(metadata))});
      }else{
        const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);
        entries.push({...row,type:'file',bytes:s.size,hash:digest.digest('hex')});
      }
    }
  }
  await walk('');return hash(JSON.stringify(entries));
}

// Internal, offline helper. Caller must verify maintenance, backup, a
// quiescent OpenClaw volume and identity from the reviewed runtime route.
export async function renewWeixinAuthorization({root,identity,candidate,action,review,now=Date.now()}) {
  let temporary, ownedTemporary;
  try {
    assert.ok(['inspect','apply','verify-saved'].includes(action));assert.equal(realpathSync(root),root);
    const indexPath=join(root,'openclaw-weixin/accounts.json'),indexStat=lstatSync(indexPath);
    assert.ok(indexStat.isFile()&&!indexStat.isSymbolicLink()&&indexStat.nlink===1&&indexStat.size<=65536&&realpathSync(indexPath)===indexPath);
    const existingIndex=JSON.parse(readFileSync(indexPath,'utf8'));
    assert.ok(Array.isArray(existingIndex)&&existingIndex.filter(id=>id===identity.accountId).length===1);
    assert.match(identity.accountId,/^[A-Za-z0-9_-]{1,128}$/);
    const relative=`openclaw-weixin/accounts/${identity.accountId}.json`,path=join(root,relative);
    const beforeBytes=privateBytes(path),before=accountObject(beforeBytes);
    const unrelated=await fingerprint(root,relative);
    const bind=(previousSha256,savedAt)=>hash(JSON.stringify({before:previousSha256,candidate,identity,unrelated,savedAt}));
    if(action!=='inspect') {
      assert.equal(review?.version,1);
      for(const key of ['binding','previousSha256','nextSha256','unrelatedSha256'])assert.match(review[key],/^[a-f0-9]{64}$/);
      now=Date.parse(review.savedAt);assert.ok(Number.isSafeInteger(now)&&now>0);
      assert.equal(new Date(now).toISOString(),review.savedAt);
      assert.equal(unrelated,review.unrelatedSha256);
      assert.equal(bind(review.previousSha256,review.savedAt),review.binding);
    }
    if(action==='verify-saved') {
      assert.equal(hash(beforeBytes),review.nextSha256);
      assert.equal(before.token,candidate.token);assert.equal(before.savedAt,review.savedAt);
      assert.equal(before.userId,identity.userId);assert.equal(candidate.userId,identity.userId);
      assert.equal(candidate.accountId,identity.accountId);
      assert.equal(before.baseUrl||'https://ilinkai.weixin.qq.com',candidate.baseUrl);
      return {status:'CLAWBOT_WEIXIN_SAVED_CREDENTIAL_VERIFIED',binding:review.binding,
        readOnlySavedCredential:true,unrelatedStatePreserved:true,remoteVerified:false};
    }
    const next=expectedWeixinCredential(before,candidate,identity,now),nextBytes=Buffer.from(JSON.stringify(next,null,2));
    const binding=bind(hash(beforeBytes),next.savedAt);
    const prepared={version:1,binding,previousSha256:hash(beforeBytes),nextSha256:hash(nextBytes),unrelatedSha256:unrelated,savedAt:next.savedAt};
    if(action==='inspect')return {status:'CLAWBOT_WEIXIN_AUTH_RENEWAL_READY_FOR_REVIEW',binding,review:prepared,remoteVerified:false};
    assert.deepEqual(review,prepared);
    assert.ok(privateBytes(path).equals(beforeBytes));
    temporary=path+`.renewal-${randomUUID()}.tmp`;
    const fd=openSync(temporary,'wx',0o600);
    ownedTemporary=fstatSync(fd);
    try{writeFileSync(fd,nextBytes);fsyncSync(fd);}finally{closeSync(fd);}
    assert.ok(privateBytes(path).equals(beforeBytes));
    renameSync(temporary,path);temporary=undefined;
    const directory=openSync(join(root,'openclaw-weixin/accounts'),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
    assert.deepEqual(accountObject(privateBytes(path)),next);
    assert.equal(await fingerprint(root,relative),unrelated);
    return {status:'CLAWBOT_WEIXIN_AUTH_SAVED_MAINTENANCE_REQUIRED',binding,unrelatedStatePreserved:true,remoteVerified:false};
  }catch{throw Error(fail);}
  finally{if(temporary&&ownedTemporary){const actual=lstatSync(temporary);
    assert.ok(actual.isFile()&&!actual.isSymbolicLink()&&actual.ino===ownedTemporary.ino&&actual.dev===ownedTemporary.dev,fail);
    unlinkSync(temporary);}}
}
