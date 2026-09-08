import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Fixed candidate, no business volumes or network. Exercise the real pinned
// official command while replacing only its Gateway transport and formatting
// dependencies. No official login, probe, receiver or Tencent request occurs.
const image = 'sha256:c903cd0e332cc2b5bdae19e1d9bf79c3f1d265c431e5b857f12ebf6c8f3842f5';
const source = fileURLToPath(new URL('../../deploy/docker/weixin-authorization.mjs', import.meta.url));
const script = `
import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {inspectConfiguredWeixin} from '/inspection/weixin-authorization.mjs';
const now=Date.now(),accountId='synthetic-selected';let fail=false,calls=0;
let payload={ts:now,channelAccounts:{'openclaw-weixin':[{accountId,enabled:true,configured:true,running:true,
  connected:true,lastError:null,lastStartAt:now-60000,lastEventAt:now-1000,token:'SECRET',userId:'PRIVATE'}]}};
const context=vm.createContext({process:{stderr:{isTTY:false}}});
const command=new vm.SourceTextModule(fs.readFileSync('/app/dist/status-DUmf9DF4.js','utf8'),{context});
const dependencies={
 './string-coerce-CIXf7egm.js':{c:v=>v?.toLowerCase()},
 './runtime-V1VdbWVS.js':{a:(runtime,value)=>runtime.log(JSON.stringify(value)),r:{}},
 './lazy-runtime-CgCh8H_K.js':{r:()=>async()=>({renderChannelsStatusFallback:async({runtime})=>runtime.log(JSON.stringify({configOnly:true,gatewayReachable:false}))})},
 './redact-sensitive-url-BN1NZvXG.js':{o:v=>v},'./errors-SkFXhz-u.js':{r:()=> 'synthetic failure'},
 './credentials-BYIlYH6F.js':{n:()=>false},
 './call-D1YmMSLH.js':{o:async options=>{assert.equal(options.method,'channels.status');assert.equal(options.params.probe,false);
   assert.equal(options.params.channel,'openclaw-weixin');assert.equal(options.timeoutMs,10000);calls++;if(fail)throw Error();return payload;}},
 './failure-output-TO-sWS9X.js':{a:()=>false,n:()=>[],o:()=>false},
 './parse-timeout-BhPKqfrV.js':{n:(_value,fallback)=>fallback},'./progress-DSeqxbrQ.js':{r:async(_options,action)=>action()}
};
await command.link(async name=>{const exports=dependencies[name];assert.ok(exports);return new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v);},{context});});
await command.evaluate();
const config={plugins:{entries:{'clawbot-bookkeeping':{config:{deploymentProfile:'production'}}}},channels:{'openclaw-weixin':{enabled:true}},
 bindings:[{type:'route',agentId:'bookkeeper',match:{channel:'openclaw-weixin',accountId}}]};
async function run(file,args,options){assert.equal(file,process.execPath);assert.deepEqual(args,['/app/openclaw.mjs','channels','status','--channel','openclaw-weixin','--json']);
 assert.equal(options.timeout,20000);let stdout='';await command.namespace.t({channel:'openclaw-weixin',json:true},{log:value=>{stdout+=value;}});return{stdout};}
let result=await inspectConfiguredWeixin(config,{run,now:()=>now});assert.equal(result.state,'last-poll-accepted');
assert.doesNotMatch(JSON.stringify(result),/SECRET|PRIVATE|synthetic-selected/);
payload.channelAccounts['openclaw-weixin'][0].lastError='CLAWBOT_WEIXIN_REAUTHORIZATION_REQUIRED';
assert.equal((await inspectConfiguredWeixin(config,{run,now:()=>now})).state,'reauthorization-required');
fail=true;assert.equal((await inspectConfiguredWeixin(config,{run,now:()=>now})).state,'gateway-unavailable');
assert.equal(calls,3);console.log('CLAWBOT_PINNED_WEIXIN_STATUS_READ_ONLY_FLOW_VERIFIED_OFFLINE');
`;
const r = spawnSync('/Applications/Docker.app/Contents/Resources/bin/docker', ['run', '--rm', '-i', '--network', 'none', '--read-only',
  '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
  '--mount', `type=bind,src=${source},dst=/inspection/weixin-authorization.mjs,readonly`, '--entrypoint', 'node', image,
  '--experimental-vm-modules', '--input-type=module', '-'], { input: script, encoding: 'utf8', timeout: 60000, maxBuffer: 65536 });
assert.equal(r.status, 0, 'CLAWBOT_OFFLINE_WEIXIN_STATUS_CHECK_FAILED');
assert.equal(r.stdout.trim(), 'CLAWBOT_PINNED_WEIXIN_STATUS_READ_ONLY_FLOW_VERIFIED_OFFLINE');
console.log(r.stdout.trim());
