import assert from 'node:assert/strict';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { assertProductionConfig } from './production-policy.mjs';
import { inspectWeixinLoginCandidate } from './weixin-login-capture.mjs';
import { renewWeixinAuthorization } from './weixin-authorization-renewal.mjs';
const stage='/weixin-authorization',target='/var/lib/clawbot/openclaw',configPath='/run/clawbot-runtime/openclaw.json';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function privateBytes(path) {
  const s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()
    &&!(s.mode&0o077)&&s.size<=65536&&realpathSync(path)===path);return readFileSync(path);
}
try {
  const action=process.argv[2];assert.ok(['inspect','apply','verify-saved'].includes(action)&&process.argv.length===3);
  let input='';for await(const chunk of process.stdin){input+=chunk;assert.ok(input.length<=16384);}
  const request=JSON.parse(input);
  assert.match(request.stageId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  const configStat=lstatSync(configPath);
  assert.ok(configStat.isFile()&&!configStat.isSymbolicLink()&&configStat.nlink===1&&configStat.size<=65536&&realpathSync(configPath)===configPath);
  const configBytes=readFileSync(configPath),config=JSON.parse(configBytes);assertProductionConfig(config);
  const paths=['initialized.json','identity.json','candidate.json'].map(name=>stage+'/'+name),bytes=paths.map(privateBytes);
  assert.deepEqual(JSON.parse(bytes[0]),{version:1,id:request.stageId});assert.equal(hash(bytes[1]),request.identitySha256);
  const identity=JSON.parse(bytes[1]),candidate=JSON.parse(bytes[2]);
  assert.equal(identity.accountId,config.bindings[0].match.accountId);
  assert.equal('openclaw-weixin:'+identity.userId,config.commands.ownerAllowFrom[0]);
  assert.equal(inspectWeixinLoginCandidate(candidate,identity),'CLAWBOT_WEIXIN_LOGIN_STAGED_SAME_IDENTITY');
  const evidence={version:1,stageSha256:hash(JSON.stringify(bytes.map(hash))),configSha256:hash(configBytes)};
  if(action!=='inspect')for(const [key,value] of Object.entries(evidence))assert.deepEqual(request.review?.[key],value);
  const result=await renewWeixinAuthorization({root:target,identity,candidate,action,review:request.review?.renewal});
  for(let i=0;i<paths.length;i++)assert.ok(privateBytes(paths[i]).equals(bytes[i]));
  assert.ok(readFileSync(configPath).equals(configBytes));
  const review=action==='inspect'?{...evidence,renewal:result.review}:request.review;
  const binding=hash(JSON.stringify(review));
  console.log(JSON.stringify({status:result.status,binding,...(action==='inspect'?{review}:{}),
    unrelatedStatePreserved:result.unrelatedStatePreserved??false,readOnlySavedCredential:result.readOnlySavedCredential??false,
    remoteVerified:false,maintenanceRequired:true}));
}catch{console.error('CLAWBOT_WEIXIN_IMPORT_REFUSED_MAINTENANCE_REQUIRED');process.exitCode=1;}
