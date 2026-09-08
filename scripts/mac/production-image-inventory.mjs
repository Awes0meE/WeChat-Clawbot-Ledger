import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
export function imageSourceInventory(files,role) {
  assert.ok(['runtime','guard'].includes(role));
  const selected={};
  for(const [source,sha256] of Object.entries(files)) {
    let target;
    if(/^deploy\/guard\/[^/]+\.(mjs|py)$/.test(source)) {
      if(role==='guard')target=source.replace('deploy/guard/','/opt/clawbot-guard/');
      else if(source.endsWith('.mjs'))target=source.replace('deploy/guard/','/opt/clawbot/guard/');
    }else if(role==='runtime') {
      if(/^deploy\/docker\/[^/]+\.mjs$/.test(source))target=source.replace('deploy/docker/','/opt/clawbot/docker/');
      else if(source==='deploy/docker/bookkeeping-linux.ts')target='/opt/clawbot/plugins/clawbot-bookkeeping/index.ts';
      else if(source==='openclaw-plugins/clawbot-bookkeeping/index.ts')target='/opt/clawbot/plugins/clawbot-bookkeeping/index-core.ts';
      else if(/^config\/(expense-categories|weixin-bookkeeper-agent.example)\.json$/.test(source))target=source.replace('config/','/opt/clawbot/config/');
      else if(/^openclaw-plugins\/clawbot-bookkeeping\/[^/]+\.mjs$/.test(source)
        ||/^openclaw-plugins\/openclaw-weixin-stable-id\/dist\/.+\.(js|map)$/.test(source))target=source.replace('openclaw-plugins/','/opt/clawbot/plugins/');
      else if(/^openclaw-workspace\/(AGENTS|SOUL|USER|IDENTITY)\.md$/.test(source))target=source.replace('openclaw-workspace/','/opt/clawbot/workspace/');
    }
    if(target){assert.match(sha256,/^[a-f0-9]{64}$/);selected[target]=sha256;}
  }
  assert.ok(Object.keys(selected).length>0);return selected;
}
export function verifyImageSourceFiles(image,files,role) {
  assert.match(image,/^sha256:[a-f0-9]{64}$/);
  const inventory=imageSourceInventory(files,role);
  const script=`import assert from 'node:assert/strict';import fs from 'node:fs';import{createHash}from'node:crypto';
    try{let input='';for await(const chunk of process.stdin){input+=chunk;assert.ok(input.length<1048576);}
      const inventory=JSON.parse(input);
      for(const[path,expected]of Object.entries(inventory)){
        const s=fs.lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&!(s.mode&0o222));
        assert.equal(createHash('sha256').update(fs.readFileSync(path)).digest('hex'),expected);
      }console.log(JSON.stringify({status:'CLAWBOT_IMAGE_SOURCE_FILES_VERIFIED',files:Object.keys(inventory).length}));
    }catch{console.error('CLAWBOT_IMAGE_SOURCE_FILES_MISSING_OR_CHANGED');process.exitCode=1;}`;
  const r=spawnSync('/Applications/Docker.app/Contents/Resources/bin/docker',['run','--rm','-i','--network','none','--read-only',
    '--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true','--entrypoint','node',image,'--input-type=module','-e',script],
    {input:JSON.stringify(inventory),encoding:'utf8',timeout:60000,maxBuffer:65536});
  assert.equal(r.status,0,'CLAWBOT_IMAGE_SOURCE_FILES_MISSING_OR_CHANGED');
  const result=JSON.parse(r.stdout);assert.equal(result.status,'CLAWBOT_IMAGE_SOURCE_FILES_VERIFIED');assert.equal(result.files,Object.keys(inventory).length);
  return result;
}
