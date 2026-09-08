import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const image='sha256:aaa345d1522a11d3616620584886bbe5af8715c542dc65eb25a37f885ca03ebb';
const r=spawnSync('/Applications/Docker.app/Contents/Resources/bin/docker',['run','--rm','--init','--network','none','--read-only',
  '--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true',
  ...['/run/clawbot-tunnel','/run/clawbot-guard','/state'].flatMap(path=>['--tmpfs',`${path}:rw,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=700`]),
  '--mount',`type=bind,src=${fileURLToPath(new URL('../../deploy',import.meta.url))},dst=/checks,readonly`,
  '--env','CLAWBOT_TUNNEL_CREDENTIAL_REHEARSAL=1','--entrypoint','node',image,'/checks/docker/verify-tunnel-credential-update.mjs'],
  {encoding:'utf8',timeout:90000,maxBuffer:1024*1024});
assert.equal(r.status,0,r.stderr);
assert.equal(r.stdout.trim(),'CLAWBOT_TUNNEL_CREDENTIAL_IMPORT_AND_EXACT_AUDIT_VERIFIED_OFFLINE');
console.log(r.stdout.trim());
