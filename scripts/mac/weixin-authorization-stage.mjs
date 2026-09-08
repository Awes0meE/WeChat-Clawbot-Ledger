import assert from 'node:assert/strict';
import { mkdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { operationsRoot } from './operation-lock.mjs';
import { credentialMaintenanceContext, credentialPrivateBytes } from './credential-maintenance-context.mjs';
import { managedVolumeName } from './managed-runtime-spec.mjs';
import { atomicPrivateReplace } from './managed-host-job.mjs';
import { validateWeixinStage, weixinStageArgs } from './weixin-authorization-stage-policy.mjs';
let context;
try {
  const [action,host,backup,input]=process.argv.slice(2);
  assert.ok(['prepare','inspect','login'].includes(action)&&host&&backup&&process.argv.length===(action==='prepare'?5:6));
  if(action==='login')assert.ok(process.stdin.isTTY&&process.stdout.isTTY,'CLAWBOT_WEIXIN_VISIBLE_TERMINAL_REQUIRED');
  context=await credentialMaintenanceContext(host,backup,'weixin-authorization-stage');
  const {spec,driver,evidence}=context,root=join(operationsRoot,'weixin-authorization-stages');
  mkdirSync(root,{recursive:true,mode:0o700});const s=lstatSync(root);
  assert.ok(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&!(s.mode&0o077)&&realpathSync(root)===root);
  const image=JSON.parse(await driver.run(['image','inspect',spec.services.openclaw.image]))[0];
  assert.equal(image.Id,spec.services.openclaw.image);assert.equal(image.Architecture,'arm64');
  assert.equal(image.Config.Labels?.['org.opencontainers.image.revision'],spec.sourceCommit);
  if(action==='prepare') {
    const id=randomUUID(),volume=`clawbot-weixin-auth-stage-${id}`,file=join(root,`${id}.json`);
    assert.equal(await driver.run(['volume','ls','--format','{{.Name}}','--filter',`name=^${volume}$`]),'');
    await driver.run(['volume','create','--label','clawbot.purpose=weixin-authorization-stage','--label',`clawbot.stage=${id}`,volume]);
    const pending={version:1,kind:'weixin-authorization-stage',id,volume,...evidence,identitySha256:null,createdAt:new Date().toISOString()};
    const pendingBytes=Buffer.from(JSON.stringify(pending));writeFileSync(file,pendingBytes,{flag:'wx',mode:0o600});
    const common=['run','--rm','--network','none','--log-driver','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true'];
    await driver.run([...common,'--user','0:0','--cap-add','CHOWN','--mount',`type=volume,src=${volume},dst=/weixin-authorization`,
      '--entrypoint','node',image.Id,'-e','const fs=require("node:fs");const p="/weixin-authorization";if(fs.readdirSync(p).length)throw Error();fs.chmodSync(p,0o700);fs.chownSync(p,1000,1000)']);
    const initialized=JSON.parse(await driver.run([...common,'--user','1000:1000',
      '--mount',`type=volume,src=${volume},dst=/weixin-authorization`,
      '--mount',`type=volume,src=${managedVolumeName(spec,'runtime-config')},dst=/weixin-target-config,readonly`,
      '--mount',`type=volume,src=${managedVolumeName(spec,'openclaw-state')},dst=/weixin-target-state,readonly`,
      '--entrypoint','node',image.Id,'/opt/clawbot/docker/weixin-authorization-stage.mjs','initialize',id]));
    assert.equal(initialized.status,'CLAWBOT_WEIXIN_STAGE_INITIALIZED');
    const stage=validateWeixinStage({...pending,identitySha256:initialized.identitySha256});
    await context.assertBackupUnchanged();atomicPrivateReplace(file,pendingBytes,Buffer.from(JSON.stringify(stage)));
    console.log(JSON.stringify({status:'CLAWBOT_WEIXIN_STAGE_PREPARED_NO_LOGIN',receipt:file,productionChanged:false}));
  } else {
    const file=resolve(input),bytes=credentialPrivateBytes(file),stage=validateWeixinStage(JSON.parse(bytes));
    assert.equal(file,join(root,`${stage.id}.json`));
    for(const [key,value] of Object.entries(evidence))assert.deepEqual(stage[key],value);
    const volume=JSON.parse(await driver.run(['volume','inspect',stage.volume]))[0];
    assert.ok(volume.Name===stage.volume&&volume.Driver==='local'&&!Object.keys(volume.Options??{}).length
      &&volume.Labels?.['clawbot.purpose']==='weixin-authorization-stage'&&volume.Labels['clawbot.stage']===stage.id
      &&!volume.Labels['clawbot.project']&&!volume.Labels['clawbot.cutover']);
    assert.equal(await driver.run(['ps','-q','--filter',`volume=${stage.volume}`]),'');
    let report;
    if(action==='inspect')report=await driver.run(weixinStageArgs(stage,'inspect'));
    else {
      const r=spawnSync('/Applications/Docker.app/Contents/Resources/bin/docker',weixinStageArgs(stage,'login'),{stdio:'inherit'});
      assert.equal(r.status,0);
    }
    assert.ok(credentialPrivateBytes(file).equals(bytes));await context.assertBackupUnchanged();
    if(report)console.log(report);
  }
}catch{console.error('CLAWBOT_WEIXIN_STAGE_STOPPED_NO_IMPORT_MAINTENANCE_REMAINS');process.exitCode=1;}
finally{context?.unlock();}
