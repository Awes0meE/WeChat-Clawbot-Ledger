import assert from 'node:assert/strict';
import { managedVolumeName } from './managed-runtime-spec.mjs';
export function validateWeixinStage(stage) {
  assert.equal(stage?.version,1);assert.equal(stage.kind,'weixin-authorization-stage');
  assert.match(stage.id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(stage.volume,`clawbot-weixin-auth-stage-${stage.id}`);
  assert.match(stage.sourceCommit,/^[a-f0-9]{40}$/);assert.match(stage.runtimeImage,/^sha256:[a-f0-9]{64}$/);
  for(const key of ['maintenanceSha256','backupManifestSha256','identitySha256'])assert.match(stage[key],/^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(stage.createdAt)));return stage;
}
export function weixinStageArgs(stage,action) {
  validateWeixinStage(stage);assert.ok(['inspect','login'].includes(action));
  return ['run','--rm',...(action==='login'?['-it']:[]),'--network',action==='login'?'bridge':'none',
    '--log-driver','none','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true',
    '--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777',
    '--mount',`type=volume,src=${stage.volume},dst=/weixin-authorization${action==='inspect'?',readonly':''}`,
    '--env','HOME=/tmp/weixin-login-state','--env','OPENCLAW_STATE_DIR=/tmp/weixin-login-state',
    '--env','OPENCLAW_CONFIG_PATH=/tmp/weixin-login-state/openclaw.json','--env','OPENCLAW_LOG_LEVEL=FATAL',
    '--entrypoint','node',stage.runtimeImage,'/opt/clawbot/docker/weixin-authorization-stage.mjs',action,stage.id,stage.identitySha256];
}
export function weixinImportArgs(stage,spec,action) {
  validateWeixinStage(stage);assert.ok(['inspect','apply','verify-saved'].includes(action));
  assert.equal(stage.runtimeImage,spec.services.openclaw.image);assert.equal(stage.sourceCommit,spec.sourceCommit);
  return ['run','--rm','-i','--network','none','--log-driver','none','--read-only','--user','1000:1000',
    '--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777',
    '--mount',`type=volume,src=${stage.volume},dst=/weixin-authorization,readonly`,
    '--mount',`type=volume,src=${managedVolumeName(spec,'openclaw-state')},dst=/var/lib/clawbot/openclaw${action==='apply'?'':',readonly'}`,
    '--mount',`type=volume,src=${managedVolumeName(spec,'runtime-config')},dst=/run/clawbot-runtime,readonly`,
    '--entrypoint','node',stage.runtimeImage,'/opt/clawbot/docker/import-weixin-authorization.mjs',action];
}
