import assert from 'node:assert/strict';

function validateIdentity(identity) {
  assert.match(identity?.accountId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.ok(typeof identity.userId==='string' && /^[^\s<>]+$/.test(identity.userId));
  const url=new URL(identity.baseUrl);
  assert.ok(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash);
}
export function inspectWeixinLoginCandidate(candidate, identity) {
  validateIdentity(identity);
  assert.ok(candidate && typeof candidate.token==='string' && /^[\x21-\x7e]{1,16384}$/.test(candidate.token));
  assert.ok(typeof candidate.accountId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(candidate.accountId));
  assert.equal(candidate.userId,identity.userId,'CLAWBOT_WEIXIN_LOGIN_WRONG_OWNER');
  const url=new URL(candidate.baseUrl);
  assert.ok(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash);
  return candidate.accountId===identity.accountId&&candidate.baseUrl===identity.baseUrl
    ? 'CLAWBOT_WEIXIN_LOGIN_STAGED_SAME_IDENTITY'
    : 'CLAWBOT_WEIXIN_LOGIN_STAGED_REQUIRES_IDENTITY_REVIEW';
}

// Login protocol only. Saving/reloading production account state is purposely
// absent from this interface; the caller supplies an isolated candidate sink.
export async function captureWeixinLogin({ identity, interactive, start, display, wait, normalize, save }) {
  assert.equal(interactive,true,'CLAWBOT_WEIXIN_LOGIN_VISIBLE_TERMINAL_REQUIRED');
  validateIdentity(identity);
  const begun=await start({accountId:identity.accountId,apiBaseUrl:identity.baseUrl,botType:'3',verbose:false});
  assert.ok(typeof begun.qrcodeUrl==='string'&&begun.qrcodeUrl.length>0&&typeof begun.sessionKey==='string');
  await display(begun.qrcodeUrl);
  const result=await wait({sessionKey:begun.sessionKey,apiBaseUrl:identity.baseUrl,timeoutMs:480000,botType:'3',verbose:false});
  if(result.alreadyConnected===true)return {status:'CLAWBOT_WEIXIN_LOGIN_NO_NEW_CREDENTIAL',productionChanged:false};
  assert.equal(result.connected,true,'CLAWBOT_WEIXIN_LOGIN_INCOMPLETE');
  assert.ok(typeof result.accountId==='string'&&result.accountId.length>0);
  const candidate={accountId:normalize(result.accountId),userId:result.userId,baseUrl:result.baseUrl?.trim()||identity.baseUrl,
    token:result.botToken,capturedAt:new Date().toISOString()};
  const status=inspectWeixinLoginCandidate(candidate,identity);
  // A same-owner changed bot or endpoint is retained privately for explicit
  // migration review, never silently accepted by the same-account importer.
  await save(candidate);
  return {status,productionChanged:false};
}
