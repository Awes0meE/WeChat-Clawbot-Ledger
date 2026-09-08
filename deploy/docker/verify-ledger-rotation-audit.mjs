import assert from 'node:assert/strict';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { MIGRATION_ROLES } from './migration-format.mjs';

assert.equal(process.env.CLAWBOT_ROTATION_AUDIT_REHEARSAL, '1');
assert.deepEqual(readdirSync('/state'), []);
for (const role of MIGRATION_ROLES) mkdirSync(`/state/${role}`, { mode:0o700 });
mkdirSync('/state/ledger-data/data', { mode:0o700 });
for (const path of ['/state/ledger-data/data/ezbookkeeping.db','/state/receipts/message-receipts.sqlite']) {
  const db=new DatabaseSync(path);db.exec('CREATE TABLE unknown_records(id INTEGER,value BLOB)');
  db.prepare('INSERT INTO unknown_records VALUES(?,?)').run(9007199254740993n,Buffer.from([0,255,1]));db.close();
}
writeFileSync('/state/secrets/http-token','original-http',{mode:0o600});
writeFileSync('/state/secrets/mcp-token','original-mcp',{mode:0o600});
writeFileSync('/state/secrets/other-secret','keep',{mode:0o600});
function audit(arg) {
  const result=spawnSync(process.execPath,[new URL('./nine-volume-audit.mjs',import.meta.url).pathname,...(arg?[arg]:[])],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0);return JSON.parse(result.stdout);
}
const full=audit(), masked=audit('--exclude-ledger-rotation');
assert.equal(masked.scope,'excluding-ledger-rotation');
writeFileSync('/state/secrets/http-token','replacement');
writeFileSync('/state/secrets/.ledger-token-rotation.json','interrupted',{mode:0o600});
writeFileSync('/state/secrets/.ledger-token-rotation-mcp.tmp','partial',{mode:0o600});
assert.deepEqual(audit('--exclude-ledger-rotation'),masked);
assert.notEqual(audit().inventorySha256,full.inventorySha256);
writeFileSync('/state/secrets/other-secret','must detect');
const changed=audit('--exclude-ledger-rotation');assert.notEqual(changed.inventorySha256,masked.inventorySha256);
const db=new DatabaseSync('/state/receipts/message-receipts.sqlite');db.exec("INSERT INTO unknown_records VALUES(42,x'02')");db.close();
assert.notDeepEqual(audit('--exclude-ledger-rotation').databases,changed.databases);
const refused=spawnSync(process.execPath,[new URL('./nine-volume-audit.mjs',import.meta.url).pathname,'--exclude-all'],{encoding:'utf8',timeout:10000});
assert.equal(refused.status,1);assert.equal(refused.stdout,'');
console.log('CLAWBOT_LEDGER_ROTATION_AUDIT_EXACT_EXCLUSIONS_AND_UNKNOWN_DATA_VERIFIED');
