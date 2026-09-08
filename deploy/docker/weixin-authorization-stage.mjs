import assert from 'node:assert/strict';
import { lstatSync, realpathSync, readFileSync, writeFileSync, readdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { assertProductionConfig } from './production-policy.mjs';
import { captureWeixinLogin, inspectWeixinLoginCandidate } from './weixin-login-capture.mjs';
const root='/weixin-authorization';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function read(path,max=65536) {
  const s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()
    &&!(s.mode&0o077)&&s.size<=max&&realpathSync(path)===path);return readFileSync(path);
}
function save(path,value) {
  const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}
  const directory=openSync(root,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}
try {
  const [action,id,expectedHash]=process.argv.slice(2);
  assert.ok(['initialize','inspect','login'].includes(action));
  assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(process.argv.length,action==='initialize'?4:5);
  assert.equal(realpathSync(root),root);
  if(action==='initialize') {
    assert.deepEqual(readdirSync(root),[]);
    const config=JSON.parse(readFileSync('/weixin-target-config/openclaw.json','utf8'));assertProductionConfig(config);
    const accountId=config.bindings[0].match.accountId,userId=config.commands.ownerAllowFrom[0].slice('openclaw-weixin:'.length);
    assert.match(accountId,/^[A-Za-z0-9_-]{1,128}$/);
    const account=JSON.parse(read(`/weixin-target-state/openclaw-weixin/accounts/${accountId}.json`));
    assert.equal(account.userId,userId);assert.ok(typeof account.token==='string'&&account.token.trim());
    const identity={accountId,userId,baseUrl:account.baseUrl||'https://ilinkai.weixin.qq.com'};
    const url=new URL(identity.baseUrl);assert.ok(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash);
    save(root+'/identity.json',identity);save(root+'/initialized.json',{version:1,id});
    console.log(JSON.stringify({status:'CLAWBOT_WEIXIN_STAGE_INITIALIZED',identitySha256:hash(read(root+'/identity.json'))}));
  } else {
    assert.deepEqual(JSON.parse(read(root+'/initialized.json')),{version:1,id});
    const bytes=read(root+'/identity.json');assert.equal(hash(bytes),expectedHash);const identity=JSON.parse(bytes);
    if(action==='inspect') {
      let candidate;
      try{candidate=JSON.parse(read(root+'/candidate.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
      console.log(JSON.stringify({status:candidate?inspectWeixinLoginCandidate(candidate,identity):'CLAWBOT_WEIXIN_LOGIN_REQUIRED',productionChanged:false}));
    } else {
      assert.ok(process.stdin.isTTY&&process.stdout.isTTY,'CLAWBOT_WEIXIN_LOGIN_VISIBLE_TERMINAL_REQUIRED');
      assert.equal(process.env.OPENCLAW_STATE_DIR,'/tmp/weixin-login-state');
      assert.equal(process.env.OPENCLAW_LOG_LEVEL,'FATAL');
      assert.ok(!readdirSync(root).includes('candidate.json'),'CLAWBOT_WEIXIN_STAGE_ALREADY_HAS_CANDIDATE');
      const {startWeixinLoginWithQr,displayQRCode,waitForWeixinLogin}=await import('/opt/clawbot/plugins/openclaw-weixin-stable-id/dist/src/auth/login-qr.js');
      const {normalizeAccountId}=await import('/opt/clawbot/plugins/openclaw-weixin-stable-id/node_modules/openclaw/dist/plugin-sdk/account-id.js');
      const result=await captureWeixinLogin({identity,interactive:true,start:startWeixinLoginWithQr,display:displayQRCode,
        wait:waitForWeixinLogin,normalize:normalizeAccountId,save:candidate=>save(root+'/candidate.json',candidate)});
      console.log(JSON.stringify(result));
    }
  }
}catch{console.error('CLAWBOT_WEIXIN_STAGE_REFUSED_NO_IMPORT');process.exitCode=1;}
