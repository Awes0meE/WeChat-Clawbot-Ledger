import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync,lstatSync,readdirSync,chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { canonicalTunnelConfig } from '../../../deploy/guard/tunnel-policy.mjs';
import { updateTunnelCredential } from '../../../deploy/docker/tunnel-credential-update.mjs';
import { tunnelCredentialArgs } from '../../../scripts/mac/tunnel-credential-policy.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const failure={message:'CLAWBOT_TUNNEL_CREDENTIAL_UPDATE_REFUSED_MAINTENANCE_REQUIRED'};
function fixture() {
  const folder=realpathSync(mkdtempSync(join(tmpdir(),'clawbot-tunnel-credential-'))),root=join(folder,'tunnel'),guardRoot=join(folder,'guard');
  mkdirSync(root,{mode:0o700});mkdirSync(guardRoot,{mode:0o700});
  const id='11111111-2222-3333-4444-555555555555';
  const original={TunnelID:id,AccountTag:'a'.repeat(32),TunnelSecret:Buffer.alloc(32,1).toString('base64'),future:{preserved:'9007199254740993'}};
  const candidate={...original,TunnelSecret:Buffer.alloc(32,2).toString('base64'),future:{ignored:'new metadata'}};
  const config=JSON.stringify(canonicalTunnelConfig(id));
  const target={sourceCommit:'b'.repeat(40),sourceSnapshotSha256:'c'.repeat(64),cutoverId:id};
  const policy={profile:'production',tunnelId:id,...target,tunnelConfigSha256:hash(config)};
  const activation={version:1,project:'clawbot-production',...target,windowsReceiverStopped:true,windowsTunnelStopped:true,windowsLedgerStopped:true};
  const put=(path,value)=>writeFileSync(path,typeof value==='string'?value:JSON.stringify(value),{mode:0o400});
  put(join(root,'config.json'),config);put(join(root,'credentials.json'),original);put(join(root,'unknown.txt'),'keep');
  put(join(guardRoot,'policy.json'),policy);put(join(guardRoot,'activation.json'),activation);
  return {folder,root,guardRoot,original,candidate,target,path:join(root,'credentials.json'),
    options:{root,guardRoot,target,candidateText:JSON.stringify(candidate)},clean:()=>rmSync(folder,{recursive:true,force:true})};
}
test('Same-Tunnel renewal preserves unknown metadata, routes and read-only credential permissions', { skip: process.platform === 'win32' ? 'Requires POSIX filesystem permissions in the Mac/Linux runtime' : false }, async()=>{
  const f=fixture();
  try {
    const before=readFileSync(f.path),config=readFileSync(join(f.root,'config.json'));
    const inspection=await updateTunnelCredential({...f.options,action:'inspect'});assert.ok(readFileSync(f.path).equals(before));
    await assert.rejects(updateTunnelCredential({...f.options,action:'verify-saved',review:inspection.review}),failure);
    const result=await updateTunnelCredential({...f.options,action:'apply',review:inspection.review});
    assert.equal(result.status,'CLAWBOT_TUNNEL_CREDENTIAL_SAVED_MAINTENANCE_REQUIRED');assert.equal(result.remoteVerified,false);
    assert.deepEqual(JSON.parse(readFileSync(f.path)),{...f.original,TunnelSecret:f.candidate.TunnelSecret});
    assert.equal(lstatSync(f.path).mode&0o777,0o400);assert.ok(readFileSync(join(f.root,'config.json')).equals(config));
    assert.equal(readFileSync(join(f.root,'unknown.txt'),'utf8'),'keep');
    assert.equal((await updateTunnelCredential({...f.options,action:'verify-saved',review:inspection.review})).readOnlySavedCredential,true);
  }finally{f.clean();}
});
test('Wrong account, Tunnel, backup target, secret encoding, changed proof and unsafe metadata refuse before writes', { skip: process.platform === 'win32' ? 'Requires POSIX filesystem permissions in the Mac/Linux runtime' : false }, async()=>{
  const f=fixture();
  try {
    const before=readFileSync(f.path),inspection=await updateTunnelCredential({...f.options,action:'inspect'});
    for(const difference of [{AccountTag:'d'.repeat(32)},{TunnelID:'22222222-2222-3333-4444-555555555555'},
      {TunnelSecret:'bad'},{TunnelSecret:f.original.TunnelSecret}]) {
      await assert.rejects(updateTunnelCredential({...f.options,candidateText:JSON.stringify({...f.candidate,...difference}),action:'apply',review:inspection.review}),failure);
      assert.ok(readFileSync(f.path).equals(before));
    }
    await assert.rejects(updateTunnelCredential({...f.options,target:{...f.target,sourceCommit:'0'.repeat(40)},action:'inspect'}),failure);
    await assert.rejects(updateTunnelCredential({...f.options,action:'apply',review:{...inspection.review,nextSha256:'0'.repeat(64)}}),failure);
    chmodSync(f.path,0o600);writeFileSync(f.path,before.toString().replace('"future":','"unsafe":9007199254740993,"future":'));chmodSync(f.path,0o400);
    const unsafe=readFileSync(f.path);await assert.rejects(updateTunnelCredential({...f.options,action:'inspect'}),failure);
    assert.ok(readFileSync(f.path).equals(unsafe));
  }finally{f.clean();}
});
test('Rename failure retains old credential, while SIGKILL after rename is recoverable by read-only proof', { skip: process.platform === 'win32' ? 'Requires POSIX filesystem permissions in the Mac/Linux runtime' : false }, async()=>{
  const f=fixture(),moduleUrl=new URL('../../../deploy/docker/tunnel-credential-update.mjs',import.meta.url).href;
  try {
    const original=readFileSync(f.path),inspection=await updateTunnelCredential({...f.options,action:'inspect'});
    for(const kill of [false,true]) {
      const child=spawnSync(process.execPath,['--input-type=module','-e',`
        import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
        const original=fs.renameSync;fs.renameSync=(...args)=>{${kill?"original(...args);process.kill(process.pid,'SIGKILL');":"throw Error('synthetic rename failure');"}};syncBuiltinESMExports();
        const {updateTunnelCredential}=await import(${JSON.stringify(moduleUrl)});
        try{await updateTunnelCredential(${JSON.stringify({...f.options,action:'apply',review:inspection.review})});process.exitCode=2;}
        catch(e){if(e.message!==${JSON.stringify(failure.message)})process.exitCode=3;}
      `],{encoding:'utf8',timeout:10000});
      assert.equal(child.stdout,'');assert.ok(readdirSync(f.root).every(x=>!x.includes('.renewal-')));
      if(kill)assert.equal(child.signal,'SIGKILL');
      else{assert.equal(child.status,0);assert.ok(readFileSync(f.path).equals(original));}
    }
    const saved=readFileSync(f.path);
    for(let i=0;i<2;i++)assert.equal((await updateTunnelCredential({...f.options,action:'verify-saved',review:inspection.review})).status,'CLAWBOT_TUNNEL_SAVED_CREDENTIAL_VERIFIED');
    assert.ok(readFileSync(f.path).equals(saved));
  }finally{f.clean();}
});
test('Tunnel import cannot publish or access business volumes; recovery has no writable volume',()=>{
  const spec={profile:'production',project:'clawbot-production',services:{openclaw:{image:'sha256:'+'a'.repeat(64)}}};
  for(const action of ['inspect','apply','verify-saved']) {
    const args=tunnelCredentialArgs(spec,action),values=flag=>args.flatMap((x,i)=>x===flag?[args[i+1]]:[]);
    const mounts=values('--mount');assert.equal(mounts.length,2);
    assert.equal(mounts[0].endsWith(',readonly'),action!=='apply');assert.ok(mounts[1].endsWith(',readonly'));
    assert.deepEqual(values('--network'),['none']);assert.deepEqual(values('--log-driver'),['none']);
    assert.ok(args.includes('--read-only'));assert.ok(!args.includes('-it'));assert.ok(!args.includes('--publish'));
    assert.ok(!mounts.some(x=>x.includes('ledger-data')||x.includes('openclaw-state')||x.includes('receipts')));
  }
});
