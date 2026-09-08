import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditReceiptReconciliation } from '../../../deploy/docker/reconciliation-audit.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-reconcile-')));
  const ledgerPath = join(directory, 'ledger.sqlite'), receiptsPath = join(directory, 'receipts.sqlite');
  const ledger = new DatabaseSync(ledgerPath), receipts = new DatabaseSync(receiptsPath);
  ledger.exec(`CREATE TABLE account(account_id INTEGER PRIMARY KEY, uid INTEGER, deleted INTEGER, currency TEXT, name TEXT);
    INSERT INTO account VALUES (11, 7, 0, 'SGD', '日常支出');
    CREATE TABLE "transaction"(transaction_id INTEGER PRIMARY KEY, uid INTEGER, account_id INTEGER, deleted INTEGER, type INTEGER, amount INTEGER, comment TEXT);
    INSERT INTO "transaction" VALUES (9007199254740993, 7, 11, 0, 3, 500, 'synthetic meal');
    CREATE TABLE unknown_ledger_table(value BLOB); INSERT INTO unknown_ledger_table VALUES (X'FF00');`);
  receipts.exec('CREATE TABLE message_receipts(receipt_key TEXT PRIMARY KEY, status TEXT, payload_json TEXT); CREATE TABLE unknown_receipt_table(value INTEGER); INSERT INTO unknown_receipt_table VALUES(9223372036854775807)');
  const add = (key, status, values = {}) => receipts.prepare('INSERT INTO message_receipts VALUES(?,?,?)')
    .run(key, status, JSON.stringify({ status, clientSessionId: sha(key), ...values }));
  t.after(() => { try { ledger.close(); } catch {} try { receipts.close(); } catch {}
    rmSync(directory, { recursive: true, force: true }); });
  const options = { ledgerPath, receiptsPath, ownerId: '7', accountId: '11' };
  return { directory, ledger, receipts, options, add, created: { transactionId: '9007199254740993', amountMinor: 500, comment: 'synthetic meal' } };
}
test('offline linkage preserves both complete databases and exact 64-bit IDs', (t) => {
  const f = fixture(t); f.add('synthetic:created', 'created', f.created); f.add('synthetic:failed', 'failed');
  const paths = [f.options.ledgerPath, f.options.receiptsPath], before = paths.map(p => sha(readFileSync(p)));
  const report = auditReceiptReconciliation(f.options);
  assert.deepEqual(report.counts, { total: 2, createdMatching: 1, failedBeforeWrite: 1, needsReview: 0 });
  assert.equal(report.automaticRestartAuthorized, false); assert.equal(report.coversUnreceiptedLedgerWrites, false);
  assert.deepEqual(paths.map(p => sha(readFileSync(p))), before);
});
test('pending and unknown stay unresolved even when a similar ledger transaction exists', (t) => {
  const f = fixture(t); f.add('synthetic:pending', 'pending'); f.add('synthetic:unknown', 'unknown', f.created);
  const result = auditReceiptReconciliation(f.options);
  assert.equal(result.counts.needsReview, 2);
  assert.ok(result.cases.every(c => c.reason === 'write-outcome-unresolved' && /^[a-f0-9]{64}$/.test(c.reference)));
  assert.ok(!JSON.stringify(result).includes('synthetic:'));
});
test('two receipt records cannot independently claim the same ledger transaction', (t) => {
  const f = fixture(t); f.add('synthetic:a', 'created', f.created); f.add('synthetic:b', 'created', f.created);
  const result = auditReceiptReconciliation(f.options);
  assert.equal(result.counts.needsReview, 1);
  assert.equal(result.cases[0].reason, 'transaction-shared-by-receipts');
});
test('wrong owner, deleted transaction, amount drift, forged session and unsupported receipt require review', (t) => {
  const f = fixture(t);
  f.add('synthetic:wrong-owner', 'created', f.created);
  f.ledger.exec('UPDATE "transaction" SET uid=8');
  assert.equal(auditReceiptReconciliation(f.options).cases[0].reason, 'created-ledger-mismatch');
  f.ledger.exec('UPDATE "transaction" SET uid=7, deleted=1');
  assert.equal(auditReceiptReconciliation(f.options).counts.needsReview, 1);
  f.ledger.exec('UPDATE "transaction" SET deleted=0, amount=501');
  assert.equal(auditReceiptReconciliation(f.options).counts.needsReview, 1);
  f.add('synthetic:forged', 'created', { ...f.created, clientSessionId: '0'.repeat(64) });
  f.add('synthetic:unsupported', 'legacy');
  assert.equal(auditReceiptReconciliation(f.options).counts.needsReview, 3);
  assert.throws(() => auditReceiptReconciliation({ ...f.options, ownerId: '8' }), /ACCOUNT/);
});
test('CLI records a private unchanged-source report, rejects overwrite and input path overrides', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t); f.add('synthetic:created', 'created', f.created); f.ledger.close(); f.receipts.close();
  for (const path of [f.options.ledgerPath, f.options.receiptsPath]) chmodSync(path, 0o600);
  const scope = join(f.directory, 'scope.json');
  writeFileSync(scope, JSON.stringify({ ownerId: '7', accountId: '11' }), { mode: 0o600 });
  const cli = new URL('../../../scripts/mac/audit-recovery-receipts.mjs', import.meta.url);
  const run = () => spawnSync(process.execPath, [fileURLToPath(cli), f.directory], { encoding: 'utf8' });
  const first = run(); assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).counts.createdMatching, 1);
  const report = join(f.directory, 'reconciliation-report.json'), original = readFileSync(report);
  assert.notEqual(run().status, 0); assert.deepEqual(readFileSync(report), original);
  rmSync(report);
  writeFileSync(scope, JSON.stringify({ ownerId: '7', accountId: '11', ledgerPath: '/invalid' }));
  assert.notEqual(run().status, 0); assert.equal(existsSync(report), false);
});
