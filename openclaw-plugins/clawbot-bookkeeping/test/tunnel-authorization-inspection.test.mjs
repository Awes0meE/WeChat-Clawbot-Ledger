import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTunnelStatus,inspectTunnelAuthorization } from '../../../scripts/mac/tunnel-authorization-inspection.mjs';
const now=1800000000000;
const status={version:1,state:'tunnel-connecting',updatedAt:now-1000,tunnel:{authorization:'credential-rejected',
  authorizationObservedAt:now-5000,diagnostic:'transport-unavailable',diagnosticObservedAt:now-2000,publisherRunning:true}};
test('Only fresh recognized diagnostics are exposed, without raw identifiers or a new cloud verification claim',()=>{
  const report=summarizeTunnelStatus({...status,secret:'synthetic',tunnel:{...status.tunnel,account:'synthetic'}},now);
  assert.equal(report.state,'observed');assert.equal(report.authorization,'credential-rejected');assert.equal(report.remoteVerified,false);
  assert.ok(!JSON.stringify(report).includes('synthetic'));
  for(const updatedAt of [now+1,now-10000])assert.equal(summarizeTunnelStatus({...status,updatedAt},now).state,'stale');
  for(const change of [{version:2},{state:'made-up'},
    {tunnel:{...status.tunnel,authorizationObservedAt:now+1}},{tunnel:{...status.tunnel,authorization:'not-checked'}},
    {tunnel:{...status.tunnel,diagnostic:'raw sensitive value'}}])
    assert.equal(summarizeTunnelStatus({...status,...change},now).state,'inspection-unavailable');
});
test('Inspection rejects replaced or restarted containers and status files older than this process start',async()=>{
  const base={identityValid:true,namespaceValid:true,running:{guard:true},trusted:{guard:'a'.repeat(64)},guardStartedAt:new Date(now-10000).toISOString()};
  for(const changed of [{...base,trusted:{guard:'b'.repeat(64)}},{...base,guardStartedAt:new Date(now-500).toISOString()},
    {...base,identityValid:false},{...base,running:{guard:false}}]) {
    let calls=0;
    const report=await inspectTunnelAuthorization({inspect:async()=>calls++===0?base:changed,readStatus:async()=>status,now:()=>now});
    assert.equal(report.state,'inspection-unavailable');
  }
  const recent={...base,guardStartedAt:new Date(now-500).toISOString()};
  assert.equal((await inspectTunnelAuthorization({inspect:async()=>recent,readStatus:async()=>status,now:()=>now})).state,'inspection-unavailable');
  assert.equal((await inspectTunnelAuthorization({inspect:async()=>base,readStatus:async()=>status,now:()=>now})).state,'observed');
  assert.equal((await inspectTunnelAuthorization({inspect:async()=>({...base,running:{guard:false}}),readStatus:()=>{throw Error('must not read');},now:()=>now})).state,'not-running');
});
