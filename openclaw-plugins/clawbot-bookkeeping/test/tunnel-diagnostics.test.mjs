import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { classifyTunnelEvent,tunnelLogReader,observeTunnelChild } from '../../../deploy/guard/tunnel-diagnostics.mjs';
const record=(message,error,level='error')=>({event:0,connIndex:0,level,message,...(error?{error}:{})});
const rejected=record('Register tunnel error from server side','Unauthorized: Invalid tunnel secret');
const accepted=record('Registered tunnel connection',undefined,'info');
test('Only exact structured registration rejection means credential rejection; missing tunnel and transport stay distinct',()=>{
  assert.equal(classifyTunnelEvent(rejected),'credential-rejected');
  assert.equal(classifyTunnelEvent({...rejected,level:'warn'}),'credential-rejected');
  assert.equal(classifyTunnelEvent(record(rejected.message,'Unauthorized: Failed to get tunnel')),'tunnel-unavailable');
  assert.equal(classifyTunnelEvent(record(rejected.message,'RPC connection closed')),'registration-failed');
  assert.equal(classifyTunnelEvent(record('Failed to dial a quic connection','timeout')),'transport-unavailable');
  assert.equal(classifyTunnelEvent(accepted),'registration-accepted');
  for(const change of [{event:1},{connIndex:undefined},{connIndex:-1},{connIndex:256},{level:'debug'},
    {message:'Application log contains Unauthorized: Invalid tunnel secret'}])assert.equal(classifyTunnelEvent({...rejected,...change}),null);
  assert.equal(classifyTunnelEvent({...rejected,error:rejected.error+' private extra detail'}),'registration-failed');
});
test('Fragmented JSON is parsed without forwarding raw fields; oversized and malformed lines are discarded and resynchronized',()=>{
  const events=[],read=tunnelLogReader(event=>events.push(event));
  const line=JSON.stringify({...rejected,token:'synthetic-secret',account:'synthetic-account'})+'\n';
  for(const part of [line.slice(0,10),line.slice(10,31),line.slice(31)])read(part);
  read('not-json\n'+JSON.stringify({message:'unrelated',error:rejected.error})+'\n');
  read('x'.repeat(16385));read(JSON.stringify(accepted)+'\n'); // Must not accept the tail of an oversized line.
  read(JSON.stringify(accepted)+'\n');
  assert.deepEqual(events,['credential-rejected','registration-accepted']);
  assert.ok(!JSON.stringify(events).includes('synthetic'));
});
test('Transport failures retain explicit rejection until accepted registration; obsolete child events are ignored',async()=>{
  const stderr=new PassThrough();let current=true,now=1000;
  const snapshot=observeTunnelChild({stderr},()=>current,()=>now);
  const emit=value=>stderr.write(JSON.stringify(value)+'\n');
  assert.equal(snapshot().authorization,'not-checked');
  emit(rejected);now=2000;emit(record('Failed to dial a quic connection','timeout'));
  assert.equal(snapshot().authorization,'credential-rejected');assert.equal(snapshot().authorizationObservedAt,1000);
  assert.equal(snapshot().diagnostic,'transport-unavailable');
  current=false;emit(accepted);assert.equal(snapshot().authorization,'credential-rejected');
  current=true;now=3000;emit(accepted);
  assert.equal(snapshot().authorization,'last-registration-accepted');assert.equal(snapshot().authorizationObservedAt,3000);
  stderr.end();
});
test('Actual child stderr is consumed as JSON without exposing its secret fields',async()=>{
  const output=[rejected,record('Unable to establish connection with Cloudflare edge','synthetic private address'),accepted];
  const child=spawn(process.execPath,['-e','for(const item of JSON.parse(process.argv[1]))console.error(JSON.stringify({...item,secret:"synthetic-secret"}))',JSON.stringify(output)],
    {stdio:['ignore','ignore','pipe']});
  const snapshot=observeTunnelChild(child,()=>true,()=>1234);
  const [code]=await once(child,'close');assert.equal(code,0);
  assert.deepEqual(snapshot(),{authorization:'last-registration-accepted',authorizationObservedAt:1234,diagnostic:'registration-accepted',diagnosticObservedAt:1234});
  assert.ok(!JSON.stringify(snapshot()).includes('synthetic'));
});
