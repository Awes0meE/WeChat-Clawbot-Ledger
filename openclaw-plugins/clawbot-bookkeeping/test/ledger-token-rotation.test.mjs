import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { rotateLedgerTokens, assertLedgerRotationComplete, rotationMarker } from '../../../deploy/docker/ledger-token-rotation.mjs';

const moduleUrl = new URL('../../../deploy/docker/ledger-token-rotation.mjs', import.meta.url).href;
const now = 1800000000;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-token-rotation-test-')));
  for (const name of ['ledger', 'secrets', 'source', 'tmp']) mkdirSync(join(root, name), { mode: 0o700 });
  const options = { ledgerRoot: join(root, 'ledger'), secretsRoot: join(root, 'secrets'), sourceRoot: join(root, 'source'),
    databaseRelativePath: 'ledger.sqlite', expectedUsername: 'reviewed-fixture-owner', now };
  const path = join(options.ledgerRoot, 'ledger.sqlite'), db = new DatabaseSync(path), uid = 9007199254740993n;
  db.exec('CREATE TABLE user(uid INTEGER,username TEXT,disabled INTEGER,deleted INTEGER); CREATE TABLE token_record(uid INTEGER,user_token_id INTEGER,token_type INTEGER,secret TEXT,created_unix_time INTEGER,expired_unix_time INTEGER); CREATE TABLE unknown_data(id INTEGER,data BLOB)');
  db.prepare('INSERT INTO user VALUES(?,?,0,0)').run(uid, options.expectedUsername);
  db.prepare('INSERT INTO unknown_data VALUES(?,?)').run(uid, Buffer.from([0,255,1]));
  const tokens = {};
  for (const [role,type] of [['http',8],['mcp',5]]) {
    const id = uid + BigInt(type), secret = 'synthetic!';
    const claims = { jti: uid.toString(), userTokenId: id.toString(), type, iat: now - 60, exp: now + 600 };
    const body = [{ alg:'HS256',typ:'JWT' }, claims].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
    tokens[role] = body + '.' + createHmac('sha256',secret).update(body).digest('base64url');
    db.prepare('INSERT INTO token_record VALUES(?,?,?,?,?,?)').run(uid,id,type,secret,claims.iat,claims.exp);
    writeFileSync(join(options.sourceRoot, role+'-token'),tokens[role],{mode:0o600});
    // Old expired or revoked tokens need not be valid to recover access.
    writeFileSync(join(options.secretsRoot, role+'-token'),'old-'+role,{mode:0o600});
  }
  db.close();
  writeFileSync(join(options.secretsRoot,'unknown-secret'),Buffer.from([0,255,8]),{mode:0o600});
  const dbHash = () => createHash('sha256').update(readFileSync(path)).digest('hex');
  return { root, options, tokens, path, dbHash, clean: () => rmSync(root,{recursive:true,force:true}) };
}
const refused = {message:'CLAWBOT_LEDGER_ROTATION_REFUSED_MAINTENANCE_REQUIRED'};

test('offline rotation binds reviewed identity and all files, saves both tokens, leaves unknown data unchanged', { skip: process.platform === 'win32' ? 'Requires POSIX filesystem permissions in the Mac/Linux runtime' : false }, async () => {
  const f=fixture(), before=f.dbHash();
  try {
    const review=await rotateLedgerTokens({...f.options,action:'inspect'});
    assert.equal(review.status,'CLAWBOT_LEDGER_ROTATION_READY_FOR_REVIEW');
    assert.equal(readFileSync(join(f.options.secretsRoot,'http-token'),'utf8'),'old-http');
    await assert.rejects(rotateLedgerTokens({...f.options,action:'apply',expectedBinding:'0'.repeat(64)}),refused);
    await assert.rejects(rotateLedgerTokens({...f.options,action:'inspect',expectedUsername:'different-owner'}),refused);
    writeFileSync(join(f.options.secretsRoot,'new-unrelated'), 'new state',{mode:0o600});
    await assert.rejects(rotateLedgerTokens({...f.options,action:'apply',expectedBinding:review.binding}),refused);
    const fresh=await rotateLedgerTokens({...f.options,action:'inspect'});
    const result=await rotateLedgerTokens({...f.options,action:'apply',expectedBinding:fresh.binding});
    assert.equal(result.status,'CLAWBOT_LEDGER_TOKENS_SAVED_MAINTENANCE_REQUIRED');
    assert.equal(result.remoteVerified,false); assert.equal(result.unrelatedStatePreserved,true);
    for(const role of ['http','mcp']) assert.equal(readFileSync(join(f.options.secretsRoot,role+'-token'),'utf8'),f.tokens[role]);
    assert.equal(f.dbHash(),before);
    assert.deepEqual(readFileSync(join(f.options.secretsRoot,'unknown-secret')),Buffer.from([0,255,8]));
    assertLedgerRotationComplete(f.options.secretsRoot);
    await assert.rejects(rotateLedgerTokens({...f.options,action:'apply',expectedBinding:fresh.binding}),refused);
  } finally {f.clean();}
});

test('SIGKILL between token renames blocks startup and resumes only the original plan', { skip: process.platform === 'win32' ? 'Requires POSIX filesystem permissions in the Mac/Linux runtime' : false }, async () => {
  const f=fixture(), before=f.dbHash();
  try {
    const review=await rotateLedgerTokens({...f.options,action:'inspect'});
    const child=spawnSync(process.execPath,['--input-type=module','-e',`
      import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const rename=fs.renameSync;
      fs.renameSync=(from,to)=>{rename(from,to);if(to.endsWith('/http-token'))process.kill(process.pid,'SIGKILL');};
      syncBuiltinESMExports();
      const {rotateLedgerTokens}=await import(${JSON.stringify(moduleUrl)});
      await rotateLedgerTokens(${JSON.stringify({...f.options,action:'apply',expectedBinding:review.binding})});
    `],{encoding:'utf8',timeout:10000,env:{...process.env,TMPDIR:join(f.root,'tmp')}});
    assert.equal(child.signal,'SIGKILL');
    assert.equal(readFileSync(join(f.options.secretsRoot,'http-token'),'utf8'),f.tokens.http);
    assert.equal(readFileSync(join(f.options.secretsRoot,'mcp-token'),'utf8'),'old-mcp');
    assert.ok(existsSync(join(f.options.secretsRoot,rotationMarker)));
    assert.throws(()=>assertLedgerRotationComplete(f.options.secretsRoot),{message:'CLAWBOT_LEDGER_ROTATION_INCOMPLETE'});
    await assert.rejects(rotateLedgerTokens({...f.options,action:'inspect'}),refused);
    await assert.rejects(rotateLedgerTokens({...f.options,action:'resume',expectedBinding:'0'.repeat(64)}),refused);
    // A partial temporary file from ENOSPC is replaceable only under that plan.
    writeFileSync(join(f.options.secretsRoot,'.ledger-token-rotation-mcp.tmp'),'partial',{mode:0o600});
    const result=await rotateLedgerTokens({...f.options,action:'resume',expectedBinding:review.binding});
    assert.equal(result.status,'CLAWBOT_LEDGER_TOKENS_SAVED_MAINTENANCE_REQUIRED');
    assert.equal(readFileSync(join(f.options.secretsRoot,'mcp-token'),'utf8'),f.tokens.mcp);
    assertLedgerRotationComplete(f.options.secretsRoot); assert.equal(f.dbHash(),before);
  } finally {f.clean();}
});

test('changed candidate, expiry, journal recovery data and dangling markers fail before replacing credentials', { skip: process.platform === 'win32' ? 'Requires POSIX filesystem permissions in the Mac/Linux runtime' : false }, async () => {
  const f=fixture();
  try {
    const review=await rotateLedgerTokens({...f.options,action:'inspect'});
    await assert.rejects(rotateLedgerTokens({...f.options,action:'apply',expectedBinding:review.binding,now:now+600}),refused);
    writeFileSync(join(f.options.sourceRoot,'mcp-token'),f.tokens.http);
    await assert.rejects(rotateLedgerTokens({...f.options,action:'apply',expectedBinding:review.binding}),refused);
    writeFileSync(join(f.options.sourceRoot,'mcp-token'),f.tokens.mcp);
    writeFileSync(f.path+'-journal','unprocessed recovery data');
    await assert.rejects(rotateLedgerTokens({...f.options,action:'inspect'}),refused);
    rmSync(f.path+'-journal');
    symlinkSync(join(f.root,'missing'),join(f.options.secretsRoot,rotationMarker));
    assert.throws(()=>assertLedgerRotationComplete(f.options.secretsRoot));
    await assert.rejects(rotateLedgerTokens({...f.options,action:'apply',expectedBinding:review.binding}),refused);
    assert.equal(readFileSync(join(f.options.secretsRoot,'http-token'),'utf8'),'old-http');
    assert.equal(readFileSync(join(f.options.secretsRoot,'mcp-token'),'utf8'),'old-mcp');
  } finally {f.clean();}
});

test('committed crash-left WAL is included in validation and remains byte-for-byte unchanged', { skip: process.platform === 'win32' ? 'Requires POSIX filesystem permissions in the Mac/Linux runtime' : false }, async () => {
  const f=fixture();
  try {
    function crashWriter(sql) {
      const result=spawnSync(process.execPath,['--input-type=module','-e',`
        import {DatabaseSync} from 'node:sqlite';
        const db=new DatabaseSync(${JSON.stringify(f.path)});
        db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
        db.exec(${JSON.stringify(sql)});
        process.kill(process.pid,'SIGKILL');
      `],{encoding:'utf8',timeout:10000});
      assert.equal(result.signal,'SIGKILL');
    }
    crashWriter("INSERT INTO unknown_data VALUES(9007199254740995,x'ff0011')");
    const before=readFileSync(f.path+'-wal'); assert.ok(before.length>0);
    await rotateLedgerTokens({...f.options,action:'inspect'});
    assert.deepEqual(readFileSync(f.path+'-wal'),before);
    crashWriter('DELETE FROM token_record WHERE token_type=5');
    const revoked=readFileSync(f.path+'-wal');
    await assert.rejects(rotateLedgerTokens({...f.options,action:'inspect'}),refused);
    assert.deepEqual(readFileSync(f.path+'-wal'),revoked);
    assert.equal(readFileSync(join(f.options.secretsRoot,'http-token'),'utf8'),'old-http');
  } finally {f.clean();}
});
