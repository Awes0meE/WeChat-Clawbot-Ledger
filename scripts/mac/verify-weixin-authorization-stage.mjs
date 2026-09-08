import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const docker='/Applications/Docker.app/Contents/Resources/bin/docker';
const image='sha256:1d3fa022e1259ecee4a5bde1a5763ac5b7b32b7dc85373154b704ea0d10beebd';
const args=['run','--rm','--network','none','--log-driver','none','--read-only','--user','1000:1000','--cap-drop','ALL',
  '--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777',
  ...['/weixin-authorization','/weixin-target-config','/weixin-target-state','/var/lib/clawbot/openclaw','/run/clawbot-runtime','/state'].flatMap(path=>
    ['--tmpfs',`${path}:rw,nosuid,nodev,size=8m,uid=1000,gid=1000,mode=700`]),
  '--mount',`type=bind,src=${fileURLToPath(new URL('../../deploy/docker',import.meta.url))},dst=/checks,readonly`,
  '--mount',`type=bind,src=${fileURLToPath(new URL('../../config',import.meta.url))},dst=/fixture-config,readonly`,
  '--env','HOME=/tmp/weixin-login-state','--env','OPENCLAW_STATE_DIR=/tmp/weixin-login-state',
  '--env','OPENCLAW_CONFIG_PATH=/tmp/weixin-login-state/openclaw.json','--env','OPENCLAW_LOG_LEVEL=FATAL',
  '--entrypoint','node',image,'/checks/verify-weixin-authorization-stage.mjs'];
const r=spawnSync(docker,args,{encoding:'utf8',timeout:90000,maxBuffer:1024*1024});
assert.equal(r.status,0,r.stderr);
assert.equal(r.stdout.trim(),'CLAWBOT_WEIXIN_STAGE_AND_IMPORT_OFFLINE_VERIFIED');
console.log(r.stdout.trim());
