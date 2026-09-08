import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const image = 'sha256:1d3fa022e1259ecee4a5bde1a5763ac5b7b32b7dc85373154b704ea0d10beebd';
const scripts = fileURLToPath(new URL('../../deploy/docker', import.meta.url));
const id = randomUUID(), prefix = `clawbot-ledger-token-check-${id}`, created = [];
const roles = ['ledger', 'secrets'];
const common = ['run', '--rm', '--init', '-i', '--log-driver', 'none', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777'];
const mounts = (writable = []) => roles.flatMap(role => ['--mount',
  `type=volume,src=${prefix}-${role},dst=/rotation/${role}${writable.includes(role) ? '' : ',readonly'}`]);
function run(args, input, fail = false) {
  const result = spawnSync(docker, args, { input, encoding: 'utf8', timeout: 60000, maxBuffer: 65536 });
  assert.ok(!result.error && Number.isInteger(result.status));
  assert.ok(fail ? result.status !== 0 : result.status === 0, 'CLAWBOT_LEDGER_TOKEN_REHEARSAL_FAILED');
  return result.stdout.trim();
}
const uid = 9007199254740993n, now = Math.floor(Date.now() / 1000), secret = 'synthetic!';
const tokens = {}, records = [];
for (const [role, type] of [['http',8],['mcp',5]]) {
  const tokenId = uid + BigInt(type), claims = { jti: uid.toString(), userTokenId: tokenId.toString(), type, iat: now-60, exp: now+3600 };
  const body = [{alg:'HS256',typ:'JWT'},claims].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  tokens[role] = body+'.'+createHmac('sha256',secret).update(body).digest('base64url');
  records.push([uid.toString(),tokenId.toString(),type,secret,claims.iat,claims.exp]);
}
const request = (action, binding = null) => ({ action, expectedBinding: binding, expectedUsername: '独立核对的合成用户', ...tokens });
function helper(action, binding, { fail = false, crash = false, overrides = {} } = {}) {
  const command = crash ? ['--input-type=module', '-e', `
    import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
    const rename=fs.renameSync;fs.renameSync=(a,b)=>{rename(a,b);if(b.endsWith('/http-token'))process.kill(process.pid,'SIGKILL');};
    syncBuiltinESMExports();await import('/checks/import-ledger-tokens.mjs');
  `] : ['/checks/import-ledger-tokens.mjs'];
  return run([...common, '--user', '1000:1000', ...mounts(action === 'inspect' ? [] : ['secrets']),
    '--mount', `type=bind,src=${scripts},dst=/checks,readonly`, '--entrypoint', 'node', image, ...command],
  JSON.stringify({...request(action,binding),...overrides}), fail || crash);
}
try {
  for (const role of roles) {
    const name = `${prefix}-${role}`;
    assert.equal(run(['volume','ls','--format','{{.Name}}','--filter',`name=^${name}$`]), '');
    run(['volume','create','--label',`clawbot.ledger-token-check=${id}`,name]); created.push(name);
  }
  run([...common,'--user','0:0','--cap-add','CHOWN',...mounts(roles),'--entrypoint','node',image,'--input-type=module','-'], `
    import fs from 'node:fs';for(const role of ['ledger','secrets']){const p='/rotation/'+role;if(fs.readdirSync(p).length)throw Error();fs.chmodSync(p,0o700);fs.chownSync(p,1000,1000);}
  `);
  run([...common,'--user','1000:1000',...mounts(roles),'--entrypoint','node',image,'--input-type=module','-'], `
    import fs from 'node:fs';import{DatabaseSync}from'node:sqlite';
    fs.mkdirSync('/rotation/ledger/data',{mode:0o700});
    const db=new DatabaseSync('/rotation/ledger/data/ezbookkeeping.db');
    db.exec('CREATE TABLE user(uid INTEGER,username TEXT,disabled INTEGER,deleted INTEGER);CREATE TABLE token_record(uid INTEGER,user_token_id INTEGER,token_type INTEGER,secret TEXT,created_unix_time INTEGER,expired_unix_time INTEGER);CREATE TABLE unrelated(id INTEGER,value BLOB)');
    db.prepare('INSERT INTO user VALUES(?,?,0,0)').run(${uid}n,'独立核对的合成用户');
    db.prepare('INSERT INTO unrelated VALUES(?,?)').run(${uid}n,Buffer.from([0,255,1]));
    for(const [u,id,type,secret,iat,exp] of ${JSON.stringify(records)})db.prepare('INSERT INTO token_record VALUES(?,?,?,?,?,?)').run(BigInt(u),BigInt(id),type,secret,iat,exp);
    db.close();for(const role of ['http','mcp'])fs.writeFileSync('/rotation/secrets/'+role+'-token','old-'+role,{mode:0o600});
    fs.writeFileSync('/rotation/secrets/unknown-secret','retained',{mode:0o600});
  `);
  const before = JSON.parse(helper('inspect'));
  assert.equal(before.status,'CLAWBOT_LEDGER_ROTATION_READY_FOR_REVIEW');
  helper('apply','0'.repeat(64),{fail:true});
  helper('resume','0'.repeat(64),{fail:true});
  helper('apply',before.binding,{fail:true,overrides:{expectedUsername:'different-owner'}});
  assert.equal(JSON.parse(helper('inspect')).binding,before.binding);
  // Host started record durable, but helper had not yet created its marker.
  assert.equal(JSON.parse(helper('resume',before.binding)).status,'CLAWBOT_LEDGER_TOKENS_SAVED_MAINTENANCE_REQUIRED');
  // Pair complete and marker removed, but host completion receipt was lost.
  assert.equal(JSON.parse(helper('resume',before.binding)).status,'CLAWBOT_LEDGER_SAVED_PAIR_VERIFIED');
  helper('resume',before.binding,{fail:true,overrides:{mcp:tokens.http}});
  run([...common,'--user','1000:1000',...mounts(['secrets']),'--entrypoint','node',image,'--input-type=module','-'], `
    import fs from 'node:fs';for(const role of ['http','mcp'])fs.writeFileSync('/rotation/secrets/'+role+'-token','old-'+role);
  `);
  assert.equal(JSON.parse(helper('inspect')).binding,before.binding);
  helper('apply',before.binding,{crash:true});
  helper('inspect',null,{fail:true});
  helper('resume','0'.repeat(64),{fail:true});
  assert.equal(JSON.parse(helper('resume',before.binding)).status,'CLAWBOT_LEDGER_TOKENS_SAVED_MAINTENANCE_REQUIRED');
  assert.equal(JSON.parse(helper('resume',before.binding)).readOnlySavedPair,true);
  console.log('CLAWBOT_LEDGER_TOKEN_IMPORT_IDENTITY_REVIEW_CRASH_AND_RECEIPT_GAPS_VERIFIED');
} finally {
  for (const name of created.reverse()) {
    const volume=JSON.parse(run(['volume','inspect',name]))[0];
    assert.equal(volume.Labels?.['clawbot.ledger-token-check'],id);
    assert.equal(run(['ps','-a','-q','--filter',`volume=${name}`]),'');
    run(['volume','rm',name]);
  }
}
