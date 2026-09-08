import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const accounts=new URL('../dist/src/auth/accounts.js',import.meta.url).href;
const logger=new URL('../dist/src/util/logger.js',import.meta.url).href;
const hooks=registerHooks({resolve(specifier,context,next){
  const path=specifier.startsWith('.')&&context.parentURL?new URL(specifier,context.parentURL).href:specifier;
  const code=path===accounts?'export const loadConfigBotAgent=()=>undefined;export const loadConfigRouteTag=()=>undefined;'
    :path===logger?'export const logger={debug(){},info(){},error(){},warn(){}};':undefined;
  return code?{url:`data:text/javascript,${encodeURIComponent(code)}`,shortCircuit:true}:next(specifier,context);
}});
const {getUpdates}=await import('../dist/src/api/api.js');hooks.deregister();
test('actual timeout adapter marks synthetic success and preserves cursor without any network',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new DOMException('synthetic timeout','AbortError');};
  try{const result=await getUpdates({baseUrl:'https://fixture.invalid',token:'synthetic',get_updates_buf:'original-cursor',timeoutMs:1});
    assert.equal(calls,1);assert.equal(result.localTransportTimeout,true);assert.equal(result.get_updates_buf,'original-cursor');assert.deepEqual(result.msgs,[]);
  }finally{globalThis.fetch=original;}
});
