import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
let dispose;
try {
  const root='/var/lib/clawbot-auth';
  assert.equal(process.env.CLAWBOT_DEPLOYMENT_PROFILE,'authorization-stage');
  assert.equal(process.env.OPENCLAW_STATE_DIR,`${root}/openclaw`);
  assert.equal(process.env.OPENCLAW_CONFIG_PATH,`${root}/openclaw/openclaw.json`);
  const config=JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH));
  const agent=config.agents.entries.bookkeeper;
  assert.equal(agent.workspace,`${root}/workspace`);
  assert.equal(agent.model.primary,'openai/gpt-5.6-sol');assert.deepEqual(agent.model.fallbacks,[]);
  assert.equal(agent.models['openai/gpt-5.6-sol'].agentRuntime.id,'codex');
  assert.deepEqual(agent.tools.deny,['*']);assert.deepEqual(config.channels,{});
  assert.deepEqual(config.plugins.allow,['openai','codex']);
  const {agentCommand}=await import('/app/dist/agent-command-CDZzL1w0.js');
  ({disposeRegisteredAgentHarnesses:dispose}=await import('/app/dist/plugin-sdk/agent-harness.js'));
  const {t:loadRegistry}=await import('/app/dist/runtime-plugins-CfPqEvbY.js');
  const {k:setActiveRegistry}=await import('/app/dist/runtime-qPjwNjo-.js');
  const registry=loadRegistry({config,basePluginIds:config.plugins.allow,workspaceDir:agent.workspace});
  assert.equal(registry.channels.length,0);assert.equal(registry.mcpServerConnectionResolvers.length,0);
  setActiveRegistry(registry,'clawbot-auth-stage-model-check','default',agent.workspace);
  const result=await agentCommand({agentId:'bookkeeper',sessionKey:`agent:bookkeeper:authorization-${randomUUID()}`,
    thinking:'low',timeout:'120',deliver:false,oneShotCliRun:true,cleanupBundleMcpOnRunEnd:true,cleanupCliLiveSessionOnRunEnd:true,
    message:'This is a model authorization check. Do not call any tools. Reply with exactly: CLAWBOT_AUTH_MODEL_OK',
  },{log(){},error(){},exit(){throw Error('model check failed');}});
  const meta=result.meta??{}, actual=meta.agentMeta??{};
  assert.equal(actual.agentHarnessId,'codex');assert.equal(actual.model,'gpt-5.6-sol');
  assert.equal(meta.aborted===true,false);
  assert.equal((result.payloads??[]).map(p=>p.text??'').join('\n').trim(),'CLAWBOT_AUTH_MODEL_OK');
  assert.deepEqual(meta.systemPromptReport?.tools?.entries??null,[]);
  console.log(JSON.stringify({status:'CLAWBOT_STAGED_MODEL_AUTH_VERIFIED',model:'gpt-5.6-sol',harness:'codex',
    remoteVerified:true,exactSyntheticReply:true,tools:0,productionChanged:false,observedAt:new Date().toISOString()}));
} catch {console.error('CLAWBOT_STAGED_MODEL_AUTH_CHECK_FAILED');process.exitCode=1;}
finally {await dispose?.();}
