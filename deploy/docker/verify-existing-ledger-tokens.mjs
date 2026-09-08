import assert from 'node:assert/strict';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { validateLedgerTokenPairInDatabase } from './ledger-token-validation.mjs';
// Read-only acceptance against the known isolated fixture, never production.
let db;
try {
  assert.equal(process.env.CLAWBOT_DEPLOYMENT_PROFILE,'isolated-test');
  const tokens={};
  for (const role of ['http','mcp']) {
    const path=`/test-secrets/${role}-token`, stat=lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink===1 && stat.uid===process.getuid()
      && !(stat.mode & 0o077) && stat.size<=16384 && realpathSync(path)===path);
    tokens[role]=readFileSync(path,'utf8').trim();
  }
  db=new DatabaseSync('/test-ledger/data/ezbookkeeping-test.db',{readOnly:true});db.exec('BEGIN');
  const users=db.prepare('SELECT uid FROM user WHERE username=? AND disabled=0 AND deleted=0 LIMIT 2'); users.setReadBigInts(true);
  const rows=users.all('clawbot-test');assert.equal(rows.length,1);
  // The fixture username is independently known; never derive the owner from JWT claims.
  const report=validateLedgerTokenPairInDatabase(db,tokens,rows[0].uid.toString());
  db.exec('COMMIT');
  for (const role of ['http','mcp']) assert.ok(readFileSync(`/test-secrets/${role}-token`,'utf8').trim()===tokens[role]);
  console.log(JSON.stringify({...report,scope:'existing-isolated-fixture'}));
} catch {console.error('CLAWBOT_EXISTING_TEST_TOKEN_VALIDATION_FAILED');process.exitCode=1;}
finally {db?.close();}
