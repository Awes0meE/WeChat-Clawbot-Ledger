import assert from 'node:assert/strict';
const states=['verifying','tunnel-ready','tunnel-connecting','blocked','publisher-failed','publisher-exited'];
const authorization=['not-checked','last-registration-accepted','credential-rejected'];
const diagnostics=['not-started','awaiting-registration','registration-accepted','credential-rejected','tunnel-unavailable','registration-failed','transport-unavailable'];
export function summarizeTunnelStatus(raw,now=Date.now()) {
  const unavailable=state=>({version:1,state,remoteVerified:false});
  try {
    assert.equal(raw?.version,1);assert.ok(states.includes(raw.state));
    assert.ok(Number.isSafeInteger(raw.updatedAt)&&raw.updatedAt>0);
    if(raw.updatedAt>now||now-raw.updatedAt>=10000)return unavailable('stale');
    const t=raw.tunnel;assert.ok(authorization.includes(t?.authorization)&&diagnostics.includes(t.diagnostic)&&typeof t.publisherRunning==='boolean');
    for(const key of ['authorizationObservedAt','diagnosticObservedAt'])assert.ok(t[key]===null||
      (Number.isSafeInteger(t[key])&&t[key]>0&&t[key]<=raw.updatedAt));
    assert.equal(t.authorizationObservedAt===null,t.authorization==='not-checked');
    assert.equal(t.diagnosticObservedAt===null,['not-started','awaiting-registration'].includes(t.diagnostic));
    return {version:1,state:'observed',guardState:raw.state,observedAt:raw.updatedAt,publisherRunning:t.publisherRunning,
      authorization:t.authorization,authorizationObservedAt:t.authorizationObservedAt,
      diagnostic:t.diagnostic,diagnosticObservedAt:t.diagnosticObservedAt,
      remoteVerified:false}; // A historical registration event is not a fresh public probe.
  }catch{return unavailable('inspection-unavailable');}
}
export async function inspectTunnelAuthorization({inspect,readStatus,now=Date.now}) {
  try {
    const before=await inspect();assert.ok(before.identityValid);
    if(!before.running.guard)return {version:1,state:'not-running',remoteVerified:false};
    assert.ok(before.namespaceValid&&/^[a-f0-9]{64}$/.test(before.trusted.guard));
    const startedAt=Date.parse(before.guardStartedAt);assert.ok(Number.isFinite(startedAt)&&startedAt<=now());
    const raw=await readStatus(before.trusted.guard),after=await inspect();
    assert.ok(after.identityValid&&after.namespaceValid&&after.running.guard&&after.trusted.guard===before.trusted.guard
      &&after.guardStartedAt===before.guardStartedAt&&raw.updatedAt>=startedAt);
    return summarizeTunnelStatus(raw,now());
  }catch{return {version:1,state:'inspection-unavailable',remoteVerified:false};}
}
