import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ORIGIN_IMAGE } from './managed-runtime-spec.mjs';

// Caller holds the operation lock and verifies the stopped source and its
// saved receipt before and after this check. Only copied ledger data is run.
export async function checkLedgerTokenClone({ run, runtimeImage, sourceProfile, volumes, assertSourceUnchanged,
  rehearsalMounts = [] }) {
  assert.match(runtimeImage, /^sha256:[a-f0-9]{64}$/);
  assert.ok(['production','isolated-test'].includes(sourceProfile));
  assert.deepEqual(Object.keys(volumes).sort(), ['config','ledger','secrets']);
  for (const name of Object.values(volumes)) assert.match(name,/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
  if (rehearsalMounts.length) assert.equal(sourceProfile,'isolated-test');
  const id=randomUUID(), volume=`clawbot-ledger-auth-check-${id}`, names=new Set(); let created=false;
  const json=async args=>JSON.parse(await run(args));
  const originImage=(await json(['image','inspect',ORIGIN_IMAGE]))[0], runtime=(await json(['image','inspect',runtimeImage]))[0];
  assert.equal(originImage.Architecture,'arm64');assert.equal(runtime.Architecture,'arm64');assert.equal(runtime.Id,runtimeImage);
  const allowedImages = new Set([originImage.Id,runtimeImage]);
  const label=['--label',`clawbot.ledger-auth-check=${id}`];
  const common=['--log-driver','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',
    '--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777'];
  function named(role) { const name=`${volume}-${role}`; names.add('/'+name);return ['--name',name,...label]; }
  try {
    await assertSourceUnchanged();
    assert.equal(await run(['volume','ls','--format','{{.Name}}','--filter',`name=^${volume}$`]),'');
    await run(['volume','create',...label,volume]); created=true;
    await run(['run','--rm',...named('init'),'--network','none',...common,'--user','0:0','--cap-add','CHOWN',
      '--mount',`type=volume,src=${volume},dst=/verification`,'--entrypoint','node',runtimeImage,'-e',
      'const fs=require("node:fs");if(fs.readdirSync("/verification").length)throw Error();fs.chmodSync("/verification",0o700);fs.chownSync("/verification",1000,1000)']);
    const prep=await run(['run','--rm',...named('prepare'),'--network','none',...common,'--user','1000:1000',
      '--mount',`type=volume,src=${volume},dst=/verification`,
      '--mount',`type=volume,src=${volumes.ledger},dst=/clone-source-ledger,readonly`,
      '--mount',`type=volume,src=${volumes.config},dst=/clone-source-config,readonly`,
      ...rehearsalMounts,'--entrypoint','node',runtimeImage,'/opt/clawbot/docker/prepare-ledger-auth-clone.mjs',sourceProfile],120000);
    assert.equal(prep,'CLAWBOT_LEDGER_AUTH_CLONE_PREPARED'); await assertSourceUnchanged();
    const origin=await run(['run','-d',...named('origin'),'--network','none',...common,'--user','1000:1000',
      '--mount',`type=volume,src=${volume},dst=/verification`,
      '--health-cmd','wget -q -O /dev/null http://127.0.0.1:18888/healthz.json','--health-interval','1s','--health-timeout','2s','--health-retries','30',
      '--entrypoint','/ezbookkeeping/ezbookkeeping',ORIGIN_IMAGE,'--conf-path','/verification/ezbookkeeping.ini','--no-boot-log','server','run']);
    assert.match(origin,/^[a-f0-9]{64}$/);
    const until=Date.now()+45000;let ready=false;
    while(Date.now()<until) {
      const c=(await json(['inspect',origin]))[0];
      assert.equal(c.Config.Labels?.['clawbot.ledger-auth-check'],id);assert.equal(c.Image,originImage.Id);
      assert.equal(c.HostConfig.NetworkMode,'none');assert.equal(Object.keys(c.HostConfig.PortBindings??{}).length,0);
      assert.ok(c.State.Running);
      if(c.State.Health?.Status==='healthy'){ready=true;break;} await delay(500);
    }
    assert.ok(ready); await assertSourceUnchanged();
    const report=JSON.parse(await run(['run','--rm',...named('probe'),'--network',`container:${origin}`,...common,'--user','1000:1000',
      '--mount',`type=volume,src=${volumes.secrets},dst=/verification-secrets,readonly`,...rehearsalMounts,
      '--entrypoint','node',runtimeImage,'/opt/clawbot/docker/probe-saved-ledger-tokens.mjs'],45000));
    await assertSourceUnchanged();
    const accepted=[report.http,report.mcp].every(r=>r?.state==='accepted-read-only'&&!r.sessionCleanup);
    assert.equal(report.businessWrites,false);
    return {version:1,status:accepted?'CLAWBOT_SAVED_TOKENS_ACCEPTED_BY_LEDGER_CLONE':'CLAWBOT_SAVED_TOKEN_SERVER_CHECK_FAILED',
      http:report.http,mcp:report.mcp,serverAcceptanceVerified:accepted,productionServiceVerified:false,
      sourceDataUnchanged:true,maintenanceRequired:true,observedAt:report.observedAt};
  } finally {
    // No broad project cleanup: a failed helper may still be running, so find
    // this operation's exact names, label and image before stopping anything.
    const ids=(await run(['ps','-a','-q','--no-trunc','--filter',`label=clawbot.ledger-auth-check=${id}`])).split('\n').filter(Boolean);
    for(const containerId of ids) {
      const c=(await json(['inspect',containerId]))[0];
      assert.ok(names.has(c.Name)&&allowedImages.has(c.Image)&&c.Config.Labels?.['clawbot.ledger-auth-check']===id);
      if(c.State.Running)await run(['stop','--time','2',containerId]);
      const remaining=await run(['ps','-a','-q','--no-trunc','--filter',`id=${containerId}`]);
      if(remaining){assert.equal(remaining,containerId);await run(['rm',containerId]);}
    }
    if(created) {
      const v=(await json(['volume','inspect',volume]))[0];assert.equal(v.Labels?.['clawbot.ledger-auth-check'],id);
      assert.equal(await run(['ps','-a','-q','--filter',`volume=${volume}`]),'');await run(['volume','rm',volume]);
    }
  }
}
