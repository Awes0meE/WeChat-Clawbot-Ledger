import assert from 'node:assert/strict';
import { readFileSync,lstatSync,realpathSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync,fstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { validateTunnelFiles } from '../guard/tunnel-policy.mjs';
const fail='CLAWBOT_TUNNEL_CREDENTIAL_UPDATE_REFUSED_MAINTENANCE_REQUIRED';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function read(path,max,secret=false) {
  const s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=max
    &&realpathSync(path)===path&&!(s.mode&0o222));
  if(secret)assert.ok(s.uid===process.getuid()&&s.gid===process.getgid()&&(s.mode&0o777)===0o400);
  return readFileSync(path);
}
function object(bytes) {
  const value=JSON.parse(bytes.toString('utf8'),(_key,value)=>{
    if(typeof value==='number')assert.ok(Number.isSafeInteger(value));return value;
  });
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value;
}
// Offline single-file update. The host must hold maintenance and the operation
// lock, authenticate the original backup, and audit all other nine-volume paths.
export async function updateTunnelCredential({root,guardRoot,target,candidateText,action,review}) {
  let temporary,owned;
  try {
    assert.ok(['inspect','apply','verify-saved'].includes(action));
    assert.equal(realpathSync(root),root);assert.equal(realpathSync(guardRoot),guardRoot);
    assert.ok(typeof candidateText==='string'&&Buffer.byteLength(candidateText)<=4096);
    const paths=[join(guardRoot,'policy.json'),join(guardRoot,'activation.json'),join(root,'config.json')];
    const inputs=paths.map(path=>read(path,16384)),policy=object(inputs[0]),activation=object(inputs[1]);
    assert.equal(policy.sourceCommit,target.sourceCommit);assert.equal(policy.sourceSnapshotSha256,target.sourceSnapshotSha256);
    assert.equal(activation.cutoverId,target.cutoverId);
    const path=join(root,'credentials.json'),beforeBytes=read(path,4096,true),before=object(beforeBytes),candidate=object(candidateText);
    validateTunnelFiles(policy,inputs[2].toString(),beforeBytes.toString(),activation);
    validateTunnelFiles(policy,inputs[2].toString(),candidateText,activation);
    assert.equal(candidate.AccountTag,before.AccountTag);assert.equal(candidate.TunnelID,before.TunnelID);
    assert.equal(Buffer.from(candidate.TunnelSecret,'base64').toString('base64'),candidate.TunnelSecret);
    const evidence={version:1,candidateSha256:hash(candidateText),policySha256:hash(inputs[0]),
      activationSha256:hash(inputs[1]),configSha256:hash(inputs[2])};
    if(action!=='inspect') {
      for(const [key,value] of Object.entries(evidence))assert.deepEqual(review?.[key],value);
      for(const key of ['previousSha256','nextSha256'])assert.match(review[key],/^[a-f0-9]{64}$/);
    }
    let status,prepared=review;
    if(action==='verify-saved') {
      assert.equal(hash(beforeBytes),review.nextSha256);assert.equal(before.TunnelSecret,candidate.TunnelSecret);
      status='CLAWBOT_TUNNEL_SAVED_CREDENTIAL_VERIFIED';
    }else {
      assert.notEqual(candidate.TunnelSecret,before.TunnelSecret);
      // Keep the original account, Tunnel ID and every unknown field. New
      // candidate metadata is not an instruction to alter the existing file.
      const next=Buffer.from(JSON.stringify({...before,TunnelSecret:candidate.TunnelSecret},null,2));
      assert.ok(next.length<=4096);
      prepared={...evidence,previousSha256:hash(beforeBytes),nextSha256:hash(next)};
      if(action==='apply') {
        assert.deepEqual(review,prepared);assert.ok(read(path,4096,true).equals(beforeBytes));
        temporary=path+`.renewal-${randomUUID()}.tmp`;
        const fd=openSync(temporary,'wx',0o400);owned=fstatSync(fd);
        try{writeFileSync(fd,next);fsyncSync(fd);}finally{closeSync(fd);}
        assert.ok(read(path,4096,true).equals(beforeBytes));renameSync(temporary,path);temporary=undefined;
        const directory=openSync(root,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
        assert.ok(read(path,4096,true).equals(next));
      }
      status=action==='inspect'?'CLAWBOT_TUNNEL_CREDENTIAL_READY_FOR_REVIEW':'CLAWBOT_TUNNEL_CREDENTIAL_SAVED_MAINTENANCE_REQUIRED';
    }
    for(let i=0;i<paths.length;i++)assert.ok(read(paths[i],16384).equals(inputs[i]));
    return {status,binding:hash(JSON.stringify(prepared)),...(action==='inspect'?{review:prepared}:{}),
      readOnlySavedCredential:action==='verify-saved',unrelatedStatePreserved:true,remoteVerified:false,maintenanceRequired:true};
  }catch{throw Error(fail);}
  finally{if(temporary&&owned){const actual=lstatSync(temporary);
    assert.ok(actual.isFile()&&!actual.isSymbolicLink()&&actual.ino===owned.ino&&actual.dev===owned.dev,fail);unlinkSync(temporary);}}
}
