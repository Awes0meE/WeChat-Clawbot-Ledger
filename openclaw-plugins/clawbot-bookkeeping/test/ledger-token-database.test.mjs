import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateLedgerTokenPairInDatabase } from '../../../deploy/docker/ledger-token-validation.mjs';
test('read-only SQLite verification preserves unknown data and rejects ambiguous, removed or inactive records', () => {
  const directory = mkdtempSync(join(tmpdir(),'clawbot-token-db-')), path=join(directory,'fixture.sqlite');
  const uid=9007199254740993n, now=1800000000, secret='synthetic!';
  const hash=()=>createHash('sha256').update(readFileSync(path)).digest('hex');
  const tokens={};
  let db;
  try {
    db=new DatabaseSync(path);
    db.exec('CREATE TABLE user(uid INTEGER,disabled INTEGER,deleted INTEGER); CREATE TABLE token_record(uid INTEGER,user_token_id INTEGER,token_type INTEGER,secret TEXT,created_unix_time INTEGER,expired_unix_time INTEGER); CREATE TABLE unrelated(id INTEGER,data BLOB)');
    db.prepare('INSERT INTO user VALUES(?,0,0)').run(uid);
    db.prepare('INSERT INTO unrelated VALUES(?,?)').run(uid,Buffer.from([0,255,1]));
    for (const [role,type] of [['http',8],['mcp',5]]) {
      const id=uid+BigInt(type), claims={jti:uid.toString(),userTokenId:id.toString(),type,iat:now-60,exp:now+600};
      const body=[{alg:'HS256',typ:'JWT'},claims].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
      tokens[role]=body+'.'+createHmac('sha256',secret).update(body).digest('base64url');
      db.prepare('INSERT INTO token_record VALUES(?,?,?,?,?,?)').run(uid,id,type,secret,claims.iat,claims.exp);
    }
    db.close();
    function verify(refused=false) {
      const before=hash(); db=new DatabaseSync(path,{readOnly:true});
      try {
        if(refused) assert.throws(()=>validateLedgerTokenPairInDatabase(db,tokens,uid.toString(),now),{message:'CLAWBOT_LEDGER_TOKEN_PAIR_REFUSED'});
        else assert.equal(validateLedgerTokenPairInDatabase(db,tokens,uid.toString(),now).sameAccount,true);
      } finally {db.close();}
      assert.equal(hash(),before,'Verification wrote to the database');
    }
    verify();
    for (const [change,restore] of [
      ['INSERT INTO token_record SELECT * FROM token_record WHERE token_type=8','DELETE FROM token_record WHERE rowid=(SELECT max(rowid) FROM token_record)'],
      ['UPDATE user SET disabled=1','UPDATE user SET disabled=0'],
      ['UPDATE user SET deleted=1','UPDATE user SET deleted=0'],
      ['UPDATE token_record SET secret=\'different!\' WHERE token_type=5',"UPDATE token_record SET secret='synthetic!' WHERE token_type=5"],
    ]) {
      db=new DatabaseSync(path);db.exec(change);db.close();verify(true);
      db=new DatabaseSync(path);db.exec(restore);db.close();verify();
    }
    db=new DatabaseSync(path);db.exec('DELETE FROM token_record WHERE token_type=5');db.close();verify(true);
  } finally { try{db?.close();}catch{} rmSync(directory,{recursive:true,force:true}); }
});
