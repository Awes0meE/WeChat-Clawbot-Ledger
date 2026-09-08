import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const id = (value) => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
  && BigInt(value) <= 9223372036854775807n;

// This is an offline review aid. It never resolves a receipt, retries a write,
// clears a fault or claims that two separate databases commit atomically.
export function auditReceiptReconciliation({ ledgerPath, receiptsPath, ownerId, accountId }) {
  if (!id(ownerId) || !id(accountId)) throw new Error('CLAWBOT_RECONCILIATION_SCOPE');
  const ledger = new DatabaseSync(ledgerPath, { readOnly: true });
  let receipts;
  try {
    receipts = new DatabaseSync(receiptsPath, { readOnly: true });
    for (const db of [ledger, receipts]) {
      if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete'
        || db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') {
        throw new Error('CLAWBOT_RECONCILIATION_OFFLINE_SNAPSHOT');
      }
      db.exec('BEGIN');
    }
    const account = ledger.prepare('SELECT currency, name FROM account WHERE account_id = ? AND uid = ? AND deleted = 0')
      .get(BigInt(accountId), BigInt(ownerId));
    if (account?.currency !== 'SGD' || account.name !== '日常支出') throw new Error('CLAWBOT_RECONCILIATION_ACCOUNT');
    const find = ledger.prepare('SELECT transaction_id, uid, account_id, deleted, type, amount, comment FROM "transaction" WHERE transaction_id = ?');
    find.setReadBigInts(true);
    const rows = receipts.prepare('SELECT receipt_key, status, payload_json FROM message_receipts ORDER BY receipt_key');
    const counts = { total: 0, createdMatching: 0, failedBeforeWrite: 0, needsReview: 0 };
    const cases = [], linkedTransactions = new Set();
    for (const row of rows.iterate()) {
      if (++counts.total > 100000) throw new Error('CLAWBOT_RECONCILIATION_BUDGET');
      let reason, payload;
      try { payload = JSON.parse(row.payload_json); } catch { reason = 'invalid-receipt'; }
      const reference = hash(row.receipt_key);
      if (!reason && (!payload || payload.status !== row.status
        || (payload.clientSessionId !== undefined && payload.clientSessionId !== reference))) reason = 'inconsistent-receipt';
      if (!reason && ['pending', 'unknown'].includes(row.status)) reason = 'write-outcome-unresolved';
      if (!reason && row.status === 'created') {
        if (!id(payload.transactionId) || !Number.isSafeInteger(payload.amountMinor) || payload.amountMinor <= 0
          || typeof payload.comment !== 'string' || payload.clientSessionId !== reference) reason = 'incomplete-created-receipt';
        else {
          const transaction = find.get(BigInt(payload.transactionId));
          if (!transaction || transaction.deleted !== 0n || transaction.uid !== BigInt(ownerId)
            || transaction.account_id !== BigInt(accountId) || transaction.type !== 3n
            || transaction.amount !== BigInt(payload.amountMinor) || transaction.comment !== payload.comment) reason = 'created-ledger-mismatch';
          else if (linkedTransactions.has(payload.transactionId)) reason = 'transaction-shared-by-receipts';
          else { linkedTransactions.add(payload.transactionId); counts.createdMatching++; }
        }
      } else if (!reason && row.status === 'failed' && payload.clientSessionId === reference) counts.failedBeforeWrite++;
      else if (!reason) reason = 'unsupported-receipt';
      if (reason) { counts.needsReview++; cases.push({ reference, reason }); }
    }
    for (const db of [ledger, receipts]) db.exec('COMMIT');
    return { version: 1, status: counts.needsReview ? 'manual-review-required' : 'receipt-links-checked', counts, cases,
      automaticRestartAuthorized: false, coversUnreceiptedLedgerWrites: false,
      scope: 'Receipt linkage only; no automatic pending/unknown resolution or state mutation.' };
  } finally { receipts?.close(); ledger.close(); }
}
