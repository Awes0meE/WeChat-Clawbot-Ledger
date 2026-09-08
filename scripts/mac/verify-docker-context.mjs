import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,realpathSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const root=realpathSync(mkdtempSync(join(tmpdir(),'clawbot-context-check-'))),context=join(root,'context'),output=join(root,'output');
const modules=['ledger-token-validation.mjs','ledger-token-rotation.mjs','import-ledger-tokens.mjs','probe-saved-ledger-tokens.mjs','verify-existing-ledger-tokens.mjs'];
try {
  mkdirSync(join(context,'deploy/docker'),{recursive:true,mode:0o700});
  writeFileSync(join(context,'.dockerignore'),readFileSync(new URL('../../.dockerignore',import.meta.url)));
  writeFileSync(join(context,'Dockerfile'),'FROM scratch\nCOPY . /context/\n');
  for(const name of modules)writeFileSync(join(context,'deploy/docker',name),'// synthetic allowed source\n');
  const excluded=['deploy/docker/http-token','deploy/docker/auth-token.json','deploy/docker/unlisted-token.mjs','deploy/docker/.env','deploy/docker/state.sqlite','testAccountInfo.txt'];
  for(const path of excluded)writeFileSync(join(context,path),'synthetic forbidden data',{mode:0o600});
  const r=spawnSync('/Applications/Docker.app/Contents/Resources/bin/docker',['build','--network','none','--output',`type=local,dest=${output}`,context],
    {env:{...process.env,PATH:`/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}`},encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  assert.equal(r.status,0,'CLAWBOT_BUILD_CONTEXT_CHECK_FAILED');
  for(const name of modules)assert.ok(existsSync(join(output,'context/deploy/docker',name)),`Missing source module: ${name}`);
  for(const path of excluded)assert.ok(!existsSync(join(output,'context',path)),`Forbidden context path: ${path}`);
  console.log('CLAWBOT_DOCKER_CONTEXT_SOURCE_INCLUDED_AND_SECRET_FILES_EXCLUDED');
}finally{rmSync(root,{recursive:true,force:true});}
