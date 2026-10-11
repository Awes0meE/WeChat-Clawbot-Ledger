import assert from 'node:assert/strict';
import { readFileSync, appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dispatchReplyWithDispatcher, finalizeInboundContext } from '/app/dist/plugin-sdk/reply-runtime.js';
import { weixinMessageToMsgContext, withWeixinInboundContext } from '/opt/clawbot/plugins/openclaw-weixin-stable-id/dist/src/messaging/inbound.js';
import { initializeGlobalHookRunner, resetGlobalHookRunner } from '/app/dist/plugin-sdk/hook-runtime.js';
import { disposeRegisteredAgentHarnesses } from '/app/dist/plugin-sdk/agent-harness.js';
import { t as loadRegistry } from '/app/dist/runtime-plugins-CfPqEvbY.js';
import { k as setActiveRegistry } from '/app/dist/runtime-qPjwNjo-.js';
import { applyWeixinMessageSendingHook, emitWeixinMessageSent } from '/opt/clawbot/plugins/openclaw-weixin-stable-id/dist/src/messaging/outbound-hooks.js';
import { resolveDeploymentProfile, TEST_PATHS } from '/opt/clawbot/plugins/clawbot-bookkeeping/deployment-profile.mjs';
import { trustedInboundMessageKey } from '/opt/clawbot/plugins/clawbot-bookkeeping/adapter.mjs';
import { CURRENCY_CODES, MULTICURRENCY_ACCOUNT_NAME } from '/opt/clawbot/plugins/clawbot-bookkeeping/currency.mjs';

import { assertBookkeeperRuntimePolicy } from './runtime-policy.mjs';
import { loadCorpus } from '/test-cases/validate.mjs';

const corpus=process.env.CLAWBOT_IMAGE_CASES
  ? JSON.parse(readFileSync(process.env.CLAWBOT_IMAGE_CASES, 'utf8')) : loadCorpus();
const selected=process.argv.slice(2);
for(const id of selected)assert.ok(corpus.cases.some((c)=>c.id===id),`Unknown case: ${id}`);
const cases=selected.length?corpus.cases.filter((c)=>selected.includes(c.id)):corpus.cases;
assert.ok(cases.length>0);
const config=JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH));
assertBookkeeperRuntimePolicy(config, ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md']
  .map((name) => readFileSync(`/opt/clawbot/workspace/${name}`, 'utf8').length));
const pluginConfig=config.plugins.entries['clawbot-bookkeeping'].config;
const deployment=resolveDeploymentProfile(pluginConfig,config);
assert.equal(deployment.origin,'http://127.0.0.1:18888');
assert.equal(config.channels['openclaw-weixin'].enabled,false);
const credential=readFileSync(TEST_PATHS.tokenPath,'utf8').trim();
async function api(path,body) {
 const r=await fetch(`${deployment.origin}/api/v1/${path}`,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(10000),
  headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json','X-Timezone-Name':'Asia/Singapore'},...(body?{body:JSON.stringify(body)}:{})});
 const data=await r.json(); if(!r.ok||data.success!==true)throw Error(`ISOLATED_API_FAILED:${path}`);return data.result;
}
let accounts=await api('accounts/list.json');
if(!accounts.length) await api('accounts/add.json',{name:'日常支出',category:1,type:1,icon:'1',color:'1e88e5',currency:'SGD',balance:0});
accounts=await api('accounts/list.json');
if(!accounts.some((a)=>a.name===MULTICURRENCY_ACCOUNT_NAME)) {
 assert.equal(accounts.length,1);assert.equal(accounts[0].name,'日常支出');
 await api('accounts/add.json',{name:MULTICURRENCY_ACCOUNT_NAME,category:1,type:2,icon:'1',color:'1e88e5',currency:'---',balance:0,
  subAccounts:CURRENCY_CODES.map((currency)=>({name:currency,category:1,type:1,icon:'1',color:'1e88e5',currency,balance:0}))});
}
const catalog=JSON.parse(readFileSync('/opt/clawbot/config/expense-categories.json'));
let categories=(await api('transaction/categories/list.json'))['2']??[];
for(const primary of catalog.categories) {
 let category=categories.find((c)=>c.name===primary.name&&c.parentId==='0');
 if(!category)category=await api('transaction/categories/add.json',{name:primary.name,type:2,parentId:'0',icon:'1',color:'ff6b22'});
 for(const name of primary.subcategories)if(!(category.subCategories??[]).some((c)=>c.name===name))await api('transaction/categories/add.json',{name,type:2,parentId:category.id,icon:'1',color:'ff6b22'});
}
categories=(await api('transaction/categories/list.json'))['2'];
const categoryNames=new Map(categories.flatMap((c)=>[[c.id,{primary:c.name,name:c.name}],...(c.subCategories??[]).map((x)=>[x.id,{primary:c.name,name:x.name}])]));
accounts=await api('accounts/list.json');
const leaves=accounts.flatMap((a)=>a.type===2?a.subAccounts:[a]);
assert.equal(leaves.length,160);
const currencies=new Map(leaves.map((a)=>[a.id,a.currency]));
const transactions=()=>api(`transactions/list/all.json?type=3&account_ids=${leaves.map((a)=>a.id).join(',')}&start_time=0&end_time=${Math.floor(Date.now()/1000)+86400}`);
const batch=randomUUID();
const resultDir='/var/lib/clawbot-test/receipts/corpus';mkdirSync(resultDir,{recursive:true,mode:0o700});
const reportPath=`${resultDir}/${batch}.jsonl`;
const registry=loadRegistry({config,basePluginIds:config.plugins.allow,workspaceDir:'/opt/clawbot/workspace'});
for(const hook of ['before_agent_run','before_prompt_build','llm_input','agent_end'])assert.ok(registry.typedHooks.some((h)=>h.pluginId==='clawbot-bookkeeping'&&h.hookName===hook));
setActiveRegistry(registry,`clawbot-corpus-${batch}`,'default','/opt/clawbot/workspace');initializeGlobalHookRunner(registry);
const clean=(s)=>String(s??'').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu,'[credential redacted]').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu,'[address redacted]').slice(0,15000);
const results=[];
const sourceTimes=new Map();
const imageProposalIds=new Map();
const corpusSha256=createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
const metadata={corpusSha256,model:'gpt-5.6-sol',harness:'codex',realWeChatSend:false};
writeFileSync(`${resultDir}/${batch}.metadata.json`,JSON.stringify(metadata),{mode:0o600});
console.log(JSON.stringify({corpus:'started',cases:cases.length,...metadata}));
try {
 for(const fixture of cases) {
  const start=Date.now(),before=await transactions();
  if(fixture.replayMessageIdFrom)assert.ok(sourceTimes.has(fixture.replayMessageIdFrom),'Select the original message before its replay');
  const sentAt=fixture.replayMessageIdFrom?sourceTimes.get(fixture.replayMessageIdFrom):start;
  sourceTimes.set(fixture.id,sentAt);
  const messageId=`corpus-${batch}-${fixture.replayMessageIdFrom??fixture.id}`;
  // Match OpenClaw's canonical lowercase session key before message_received.
  const sessionKey=`agent:bookkeeper:openclaw-weixin:clawbot-test-account:direct:corpus-${batch}-${fixture.conversation??fixture.id}`.toLowerCase();
  const deliveries=[],authorities=[];
  let message=fixture.message;
  if(fixture.confirmationOf) {
    assert.ok(process.env.CLAWBOT_IMAGE_CASES && imageProposalIds.has(fixture.confirmationOf));
    message=`${fixture.decision==='cancel'?'取消':'确认'}第${imageProposalIds.get(fixture.confirmationOf)}笔`;
  }
  const ctx={
   Body:message,RawBody:message,CommandBody:message,
   From:'clawbot-test-owner',To:'clawbot-test-owner',SenderId:'clawbot-test-owner',Provider:'openclaw-weixin',Surface:'openclaw-weixin',
   OriginatingChannel:'openclaw-weixin',OriginatingTo:'clawbot-test-owner',AccountId:'clawbot-test-account',ChatType:'direct',
   MessageSid:messageId,Timestamp:sentAt,CommandAuthorized:true,SessionKey:sessionKey,
  };
  if (fixture.image) {
    assert.ok(process.env.CLAWBOT_IMAGE_CASES, 'Image fixtures require an explicit private suite');
    const mediaDir='/var/lib/clawbot-test/openclaw/media/inbound';mkdirSync(mediaDir,{recursive:true,mode:0o700});
    const path=`${mediaDir}/${messageId}.jpg`;copyFileSync(fixture.image,path);
    Object.assign(ctx,weixinMessageToMsgContext({message_id:messageId,from_user_id:'clawbot-test-owner',create_time_ms:sentAt,
      item_list:[{type:2},...(fixture.message?[{type:1,text_item:{text:fixture.message}}]:[])]},'clawbot-test-account',{decryptedPicPath:path}));
  }
  await withWeixinInboundContext(ctx, () => dispatchReplyWithDispatcher({config,cfg:config,ctx:fixture.image?finalizeInboundContext(ctx):ctx,dispatcherOptions:{deliver:async(payload,info)=>{
   if(info.kind!=='final')return;
   const deliveryRun=`corpus-delivery-${messageId}`;
   const sending=await applyWeixinMessageSendingHook({to:'clawbot-test-owner',accountId:'clawbot-test-account',runId:deliveryRun,text:payload.text??''});
   if(sending.cancelled){if(fixture.replayMessageIdFrom)return;throw Error('SYNTHETIC_DELIVERY_CANCELLED');}
   const db=new DatabaseSync(TEST_PATHS.stateDbPath,{readOnly:true});
   try{authorities.push(...db.prepare('SELECT text FROM pending_authoritative_replies WHERE source_message_key=?').all(trustedInboundMessageKey('openclaw-weixin',messageId)).map((r)=>r.text));}finally{db.close();}
   deliveries.push(clean(sending.text));
   emitWeixinMessageSent({to:'clawbot-test-owner',accountId:'clawbot-test-account',runId:deliveryRun,content:sending.text,success:true});
  },onError:()=>{throw Error('SYNTHETIC_DELIVERY_ERROR');}},replyOptions:{disableBlockStreaming:true}}));
  const after=await transactions();
  const beforeIds=new Set(before.map((r)=>r.id)),afterIds=new Set(after.map((r)=>r.id));
  const added=after.filter((r)=>!beforeIds.has(r.id));
  const deleted=before.filter((r)=>!afterIds.has(r.id));
  const db=new DatabaseSync(TEST_PATHS.stateDbPath,{readOnly:true});
  let pending;
  try{pending=[...db.prepare('SELECT payload_json FROM pending_expense_confirmations').all(),
    ...(fixture.image?db.prepare("SELECT id, payload_json FROM image_expense_proposals WHERE status='active'").all():[])]
    .map((r)=>({...JSON.parse(r.payload_json),proposalId:r.id})).find((p)=>p.sourceInbound?.messageId===messageId);
    if(pending?.proposalId)imageProposalIds.set(fixture.id,pending.proposalId);
  }finally{db.close();}
  const expense=added.map((r)=>({amount:(r.sourceAmount/100).toFixed(2),currency:currencies.get(r.sourceAccountId),category:categoryNames.get(r.categoryId),comment:clean(r.comment),time:r.time}));
  const issues=[];const e=fixture.expected;
  if(fixture.replayMessageIdFrom?deliveries.length>1:deliveries.length!==1)issues.push('unexpected-final-reply-count');
  if(deleted.length)issues.push('unexpected-deletion');
  if(added.length>1)issues.push('multiple-expenses-from-one-message');
  if(e.action==='record'&&added.length!==1)issues.push('expected-one-write');
  if(e.action!=='record'&&added.length)issues.push('unexpected-write');
  if(e.action==='prepare'&&!pending)issues.push('expected-confirmation-proposal');
  if(fixture.image&&e.action==='reject'&&pending)issues.push('unexpected-confirmation-proposal');
  if(e.action==='cancel'&&!/取消|没记|不记|作废|撤/u.test(deliveries.join('\n')))issues.push('expected-cancellation-reply');
  if(['record','prepare','query','cancel'].includes(e.action)&&(!authorities.length||!deliveries.every((r)=>authorities.some((a)=>clean(a)===r))))issues.push('reply-not-current-message-authority');
  if(e.amount&&added.length===1&&Number(expense[0].amount)!==Number(e.amount))issues.push('wrong-amount');
  if(e.amountOneOf&&added.length===1&&!e.amountOneOf.some((a)=>Number(a)===Number(expense[0].amount)))issues.push('ungrounded-written-amount');
  if(e.currency&&added.length===1&&expense[0].currency!==e.currency)issues.push('wrong-currency');
  if(pending){if(e.amount&&Number(pending.input.amount)!==Number(e.amount))issues.push('wrong-proposal-amount');if(e.amountOneOf&&!e.amountOneOf.some((a)=>Number(a)===Number(pending.input.amount)))issues.push('ungrounded-proposal-amount');if(e.currency&&pending.input.currency!==e.currency)issues.push('wrong-proposal-currency');}
  if(added.length===1){
   const local=new Date(expense[0].time*1000+8*3600000).toISOString();
   if(e.category&&JSON.stringify([expense[0].category?.primary,expense[0].category?.name])!==JSON.stringify(e.category))issues.push('wrong-category');
   if(e.commentEquals!==undefined&&expense[0].comment!==e.commentEquals)issues.push('wrong-comment');
   if(e.localDate&&local.slice(0,10)!==e.localDate)issues.push('wrong-explicit-date');
   if(e.localTime&&local.slice(11,16)!==e.localTime)issues.push('wrong-explicit-clock');
   if(e.localSecond!==undefined&&Number(local.slice(17,19))!==e.localSecond)issues.push('wrong-explicit-second');
  }
  if(['record','prepare'].includes(e.action))for(const label of ['账本：','支出：','分类：','备注：','时间：'])if(!deliveries.join('\n').includes(label))issues.push(`incomplete-receipt:${label}`);
  if(e.dayOffset!==undefined&&added.length===1){const day=(ms)=>new Date(ms+8*3600000).toISOString().slice(0,10);if(day(expense[0].time*1000)!==day(start+e.dayOffset*86400000))issues.push('wrong-consumption-day');}
  for(const piece of e.replyContains??[])if(!deliveries.join('\n').includes(piece))issues.push(`missing-answer:${piece}`);
  if(e.action==='query'&&/没有成功|暂时连不上|没查成功|暂时不能确认账本/u.test(deliveries.join('\n')))issues.push('query-failed');
  const result={corpus:'case',id:fixture.id,group:fixture.group,message:fixture.message,expected:e,passed:issues.length===0,issues,
   durationMs:Date.now()-start,reply:deliveries.join('\n'),writes:expense,pending:pending?{amount:pending.input.amount,currency:pending.input.currency}:null,authoritative:authorities.length>0};
  appendFileSync(reportPath,JSON.stringify(result)+'\n',{mode:0o600});results.push(result);console.log(JSON.stringify(result));
 }
 console.log(JSON.stringify({corpus:'finished',total:results.length,passed:results.filter((r)=>r.passed).length,failed:results.filter((r)=>!r.passed).length,reportPath}));
 if(results.some((r)=>!r.passed))process.exitCode=1;
} finally {
 await disposeRegisteredAgentHarnesses();
 for(const hook of registry.typedHooks.filter((h)=>h.hookName==='gateway_stop'))await hook.handler({},{});
 resetGlobalHookRunner();
 writeFileSync(`${resultDir}/${batch}.summary.json`,JSON.stringify({total:results.length,passed:results.filter((r)=>r.passed).length,finishedAt:new Date().toISOString()}),{mode:0o600});
}
process.exit(process.exitCode??0);
