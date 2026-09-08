import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const fixture={},key=Symbol.for('clawbot.weixin.monitor-auth-check');globalThis[key]=fixture;
const modules=new Map(),prelude=`const fixture=globalThis[Symbol.for('clawbot.weixin.monitor-auth-check')];`;
function mock(path,code){modules.set(new URL(path,import.meta.url).href,`data:text/javascript,${encodeURIComponent(prelude+code)}`);}
mock('../dist/src/api/api.js',`
 export async function getUpdates(){const next=fixture.queue.shift();if(next===undefined){fixture.controller.abort();return {ret:0};}if(next instanceof Error)throw next;return next;}
 export function classifyFetchError(){return {type:'unknown',description:'synthetic transport failure'};}
`);
mock('../dist/src/api/config-cache.js','export class WeixinConfigManager{async getForUser(){return {};}}');
mock('../dist/src/api/session-guard.js','export const STALE_TOKEN_ERRCODE=-14;export function pauseSession(){fixture.pauses++;}export function getRemainingPauseMs(){return 1;}');
mock('../dist/src/messaging/process-message.js','export async function processOneMessage(){fixture.processed++;if(fixture.processingFailure)throw Error("synthetic message failure");}');
mock('../dist/src/storage/sync-buf.js','export const getSyncBufFilePath=()=>"synthetic-sync";export const loadGetUpdatesBuf=()=>"saved-cursor";export function saveGetUpdatesBuf(_,value){fixture.saved.push(value);}');
mock('../dist/src/util/logger.js','const sink={debug(){},info(){},error(){},warn(){}};export const logger={...sink,withAccount:()=>sink};');
const hook=registerHooks({resolve(specifier,context,next){const path=specifier.startsWith('.')&&context.parentURL?new URL(specifier,context.parentURL).href:specifier;const url=modules.get(path);return url?{url,shortCircuit:true}:next(specifier,context);}});
const {monitorWeixinProvider}=await import('../dist/src/monitor/monitor.js');hook.deregister();
after(()=>delete globalThis[key]);
async function run(queue,processingFailure=false){
  Object.assign(fixture,{queue:[...queue],controller:new AbortController(),pauses:0,saved:[],processed:0,processingFailure});
  const status=[],snapshot={};const realTimeout=globalThis.setTimeout;
  globalThis.setTimeout=(callback,ms,...args)=>realTimeout(callback,Math.min(ms,1),...args);
  try{await monitorWeixinProvider({baseUrl:'https://fixture.invalid',cdnBaseUrl:'https://fixture.invalid',accountId:'synthetic-account',token:'synthetic-token',config:{},channelRuntime:{},abortSignal:fixture.controller.signal,
    setStatus:value=>{status.push(value);Object.assign(snapshot,value);}});}
  finally{globalThis.setTimeout=realTimeout;}
  return {status,snapshot};
}
test('stale token is visible during the existing pause; successful later poll clears that status',async()=>{
  const result=await run([{ret:-14,errmsg:'private server error'},
    {ret:0,msgs:[],localTransportTimeout:true,get_updates_buf:'saved-cursor'},new Error('synthetic network error'),
    {ret:0,msgs:[],get_updates_buf:'next-cursor'}]);
  assert.equal(fixture.pauses,1);assert.equal(result.status[0].lastError,'CLAWBOT_WEIXIN_REAUTHORIZATION_REQUIRED');
  assert.equal(result.status[1].lastError,'CLAWBOT_WEIXIN_REAUTHORIZATION_REQUIRED');
  assert.equal(result.status[2].lastError,'CLAWBOT_WEIXIN_REAUTHORIZATION_REQUIRED');
  assert.equal(result.snapshot.connected,true);assert.equal(result.snapshot.lastError,null);
  assert.deepEqual(fixture.saved,['next-cursor']);assert.ok(!JSON.stringify(result.status).includes('private server error'));
});
test('transport failure and local timeout never request login or claim successful server acceptance',async()=>{
  const result=await run([new Error('private transport detail'),{ret:0,msgs:[],localTransportTimeout:true}]);
  assert.equal(result.status[0].lastError,'CLAWBOT_WEIXIN_TRANSPORT_UNAVAILABLE');
  assert.equal(result.snapshot.lastError,'CLAWBOT_WEIXIN_POLL_TIMEOUT');assert.equal(result.snapshot.connected,false);
  assert.equal(fixture.pauses,0);assert.deepEqual(fixture.saved,[]);
});
test('message processing failure does not misclassify an accepted poll as a transport/auth failure',async()=>{
  const result=await run([{ret:0,msgs:[{from_user_id:'synthetic-owner',item_list:[]}]}],true);
  assert.equal(fixture.processed,1);assert.equal(result.snapshot.connected,true);
  assert.equal(result.snapshot.lastError,'CLAWBOT_WEIXIN_MESSAGE_PROCESSING_FAILED');
});
