import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertDeploymentOrigin, PRODUCTION_DEPLOYMENT } from './deployment-profile.mjs';
import { normalizeCurrency, validateExchangeRates } from './currency.mjs';
import { scopedExpenseAccounts, selectExpenseWriteAccount } from './expense-accounts.mjs';
import { fetchBankOfChinaSpotSell } from './bank-of-china-rates.mjs';
import { normalizeImageAttachment, validateImageExpense } from './image-expense.mjs';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const TRANSACTION_NOT_FOUND = Symbol('verified-transaction-not-found');
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_BUSY_RETRY_MS = 10;
const TRUSTED_RUN_END_TTL_MS = 10 * 60 * 1000;
const CONFIRMATION_HISTORY_MIGRATION_KEY = 'processed-expense-confirmations-v1';
const INBOUND_FRESHNESS_MIGRATION_KEY = 'trusted-inbound-freshness-v1';
const SQLITE_BUSY_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export function isSqliteBusyError(error) {
  return Number.isInteger(error?.errcode) && (error.errcode & 0xff) === 5;
}

function enableWalWithBusyRetry(database) {
  const deadline = Date.now() + SQLITE_BUSY_TIMEOUT_MS;
  while (true) {
    try {
      database.exec('PRAGMA journal_mode = WAL;');
      return;
    } catch (error) {
      const remaining = deadline - Date.now();
      if (!isSqliteBusyError(error) || remaining <= 0) throw error;
      Atomics.wait(
        SQLITE_BUSY_WAIT,
        0,
        0,
        Math.min(SQLITE_BUSY_RETRY_MS, remaining),
      );
    }
  }
}

export function trustedInboundMessageKey(channel, messageId) {
  return createHash('sha256').update(`message\u0000${channel}\u0000${messageId}`, 'utf8').digest('hex');
}

function normalizeTrustedInboundPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.channel !== 'string' || value.channel.trim() === ''
    || typeof value.messageId !== 'string' || value.messageId.trim() === ''
    || typeof value.content !== 'string'
    || !Number.isFinite(value.timestamp) || value.timestamp <= 0
    || !Number.isFinite(value.observedAt) || value.observedAt <= 0
    || (value.timeSource !== 'message' && value.timeSource !== 'received')) {
    return undefined;
  }
  return {
    channel: value.channel,
    messageId: value.messageId,
    content: value.content,
    timestamp: value.timestamp,
    observedAt: value.observedAt,
    timeSource: value.timeSource,
    ...(normalizeImageAttachment(value.image) ? { image: normalizeImageAttachment(value.image), imageAccountId: value.imageAccountId,
      recipientKey: value.recipientKey } : {}),
  };
}

const HASH_KEY_PATTERN = /^[a-f0-9]{64}$/u;

function normalizePendingExpenseProposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.sourceMessageKey !== 'string'
    || !HASH_KEY_PATTERN.test(value.sourceMessageKey)
    || !value.input || typeof value.input !== 'object' || Array.isArray(value.input)) {
    return undefined;
  }
  const sourceInbound = normalizeTrustedInboundPayload(value.sourceInbound);
  const conversationKey = value.sourceInbound?.conversationKey;
  const input = value.input;
  let currency;
  try { currency = normalizeCurrency(input.currency); } catch { return undefined; }
  if (currency !== input.currency) return undefined;
  const receivedTime = input.timeMode === 'received';
  const explicitTime = input.timeMode === 'explicit'
    && /^\d{4}-\d{2}-\d{2}$/u.test(input.localDate)
    && (input.localTime === undefined || /^\d{2}:\d{2}$/u.test(input.localTime))
    && typeof input.timeEvidence === 'string'
    && input.timeEvidence.trim() !== ''
    && Array.from(input.timeEvidence).length <= 100;
  if (!sourceInbound || typeof conversationKey !== 'string' || !HASH_KEY_PATTERN.test(conversationKey)
    || !Number.isSafeInteger(value.resolvedTime) || value.resolvedTime <= 0
    || (!receivedTime && !explicitTime)
    || typeof input.amount !== 'string'
    || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(input.amount)
    || typeof input.primaryCategory !== 'string' || input.primaryCategory.trim() === ''
    || typeof input.subcategory !== 'string' || input.subcategory.trim() === ''
    || (input.comment !== undefined
      && (typeof input.comment !== 'string' || Array.from(input.comment).length > 255))) {
    return undefined;
  }
  if (sourceInbound.image) {
    try { validateImageExpense(input, sourceInbound); } catch { return undefined; }
  }
  return {
    sourceMessageKey: value.sourceMessageKey,
    resolvedTime: value.resolvedTime,
    sourceInbound: { ...sourceInbound, conversationKey },
    input: {
      ...(sourceInbound.image ? { imageEvidence: input.imageEvidence } : {}),
      amount: input.amount,
      currency: input.currency,
      timeMode: input.timeMode,
      ...(input.timeMode === 'explicit' ? {
        localDate: input.localDate,
        ...(input.localTime === undefined ? {} : { localTime: input.localTime }),
        timeEvidence: input.timeEvidence,
      } : {}),
      primaryCategory: input.primaryCategory,
      subcategory: input.subcategory,
      ...(input.comment === undefined ? {} : { comment: input.comment }),
    },
  };
}

function expenseCategoryId(value) {
  if ((typeof value !== 'string' && typeof value !== 'number')
    || (typeof value === 'number' && !Number.isFinite(value))
    || String(value).trim() === '') {
    throw new Error('expense transaction category id is invalid');
  }
  return String(value);
}

function sanitizeExpenseTransaction(transaction) {
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
    throw new Error('expense transaction record is invalid');
  }
  if (transaction.type !== 3) {
    throw new Error('expense transaction type is invalid');
  }
  if (!Number.isSafeInteger(transaction.sourceAmount) || transaction.sourceAmount <= 0) {
    throw new Error('expense transaction amount is invalid');
  }
  if (!Number.isSafeInteger(transaction.time) || transaction.time <= 0
    || !Number.isFinite(new Date(transaction.time * 1000).getTime())) {
    throw new Error('expense transaction time is invalid');
  }
  let categoryName;
  if (transaction.category !== undefined) {
    if (!transaction.category || typeof transaction.category !== 'object' || Array.isArray(transaction.category)) {
      throw new Error('expense transaction category is invalid');
    }
    if (transaction.category.name !== undefined && typeof transaction.category.name !== 'string') {
      throw new Error('expense transaction category name is invalid');
    }
    categoryName = transaction.category.name?.trim() || undefined;
  }
  return {
    time: transaction.time,
    sourceAmount: transaction.sourceAmount,
    categoryId: expenseCategoryId(transaction.categoryId),
    categoryName,
  };
}

function expenseSearchSequence(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/u.test(value)
    || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new Error('expense search response is invalid');
  }
  return BigInt(value);
}

export class SqliteReceiptStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    enableWalWithBusyRetry(this.database);
    this.database.exec('PRAGMA synchronous = FULL;');
    this.database.exec('PRAGMA secure_delete = ON;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS message_receipts (
        receipt_key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trusted_inbound_queue (
        arrival_order INTEGER PRIMARY KEY AUTOINCREMENT,
        message_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        claimed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS trusted_inbound_queue_lookups (
        lookup_key TEXT NOT NULL,
        message_key TEXT NOT NULL,
        PRIMARY KEY (lookup_key, message_key)
      );
      CREATE INDEX IF NOT EXISTS trusted_inbound_queue_lookup
      ON trusted_inbound_queue_lookups (lookup_key, message_key);
      CREATE TABLE IF NOT EXISTS ended_trusted_runs (
        run_key TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_expense_confirmations (
        conversation_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_expense_confirmations (
        message_key TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS image_expense_links (
        evidence_key TEXT PRIMARY KEY,
        receipt_key TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS image_expense_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_key TEXT NOT NULL,
        source_message_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE IF NOT EXISTS receipt_store_migrations (
        migration_key TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_authoritative_replies (
        reply_key TEXT PRIMARY KEY,
        delivery_key TEXT NOT NULL,
        recipient_key TEXT NOT NULL,
        text TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        reserved_by TEXT,
        reserved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS pending_authoritative_replies_delivery
      ON pending_authoritative_replies (delivery_key, expires_at, reserved_by);
      CREATE INDEX IF NOT EXISTS pending_authoritative_replies_recipient
      ON pending_authoritative_replies (recipient_key, expires_at, reserved_by);
    `);
    try {
      this.#migrateLegacyTrustedInboundMessages();
      this.#migrateProcessedExpenseConfirmations();
      this.#migrateInboundFreshness();
    } catch (error) {
      this.database.close();
      throw error;
    }
    this.insertPending = this.database.prepare(`
      INSERT OR IGNORE INTO message_receipts (receipt_key, status, payload_json, updated_at)
      VALUES (?, 'pending', '{"status":"pending"}', ?)
    `);
    this.selectReceipt = this.database.prepare(`
      SELECT payload_json FROM message_receipts WHERE receipt_key = ?
    `);
    this.updateReceipt = this.database.prepare(`
      UPDATE message_receipts
      SET status = ?, payload_json = ?, updated_at = ?
      WHERE receipt_key = ?
    `);
    this.insertTrustedInbound = this.database.prepare(`
      INSERT OR IGNORE INTO trusted_inbound_queue (message_key, payload_json, expires_at)
      VALUES (?, ?, ?)
    `);
    this.reactivateTrustedInbound = this.database.prepare(`
      UPDATE trusted_inbound_queue
      SET arrival_order = (
            SELECT COALESCE(MAX(pending.arrival_order), 0) + 1
            FROM trusted_inbound_queue AS pending
          ),
          payload_json = ?, expires_at = ?, claimed_at = NULL
      WHERE message_key = ? AND claimed_at IS NOT NULL
    `);
    this.insertTrustedInboundLookup = this.database.prepare(`
      INSERT OR IGNORE INTO trusted_inbound_queue_lookups (lookup_key, message_key)
      VALUES (?, ?)
    `);
    this.claimTrustedInboundMessage = this.database.prepare(`
      UPDATE trusted_inbound_queue
      SET claimed_at = ?, payload_json = '{}'
      WHERE message_key = ? AND claimed_at IS NULL
    `);
    this.deleteExpiredTrustedInboundLookups = this.database.prepare(`
      DELETE FROM trusted_inbound_queue_lookups
      WHERE message_key IN (
        SELECT message_key FROM trusted_inbound_queue
        WHERE claimed_at IS NULL AND expires_at < ?
      )
    `);
    this.deleteExpiredTrustedInboundMessages = this.database.prepare(`
      DELETE FROM trusted_inbound_queue
      WHERE claimed_at IS NULL AND expires_at < ?
    `);
    this.upsertEndedTrustedRun = this.database.prepare(`
      INSERT INTO ended_trusted_runs (run_key, expires_at) VALUES (?, ?)
      ON CONFLICT(run_key) DO UPDATE SET
        expires_at = MAX(ended_trusted_runs.expires_at, excluded.expires_at)
    `);
    this.selectEndedTrustedRun = this.database.prepare(`
      SELECT 1 FROM ended_trusted_runs WHERE run_key = ? AND expires_at >= ?
    `);
    this.deleteExpiredEndedTrustedRuns = this.database.prepare(`
      DELETE FROM ended_trusted_runs WHERE expires_at < ?
    `);
    this.upsertPendingExpenseConfirmation = this.database.prepare(`
      INSERT INTO pending_expense_confirmations
        (conversation_key, payload_json, expires_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `);
    this.selectPendingExpenseConfirmation = this.database.prepare(`
      SELECT payload_json, expires_at
      FROM pending_expense_confirmations
      WHERE conversation_key = ?
    `);
    this.deletePendingExpenseConfirmation = this.database.prepare(`
      DELETE FROM pending_expense_confirmations
      WHERE conversation_key = ?
    `);
    this.insertProcessedExpenseConfirmation = this.database.prepare(`
      INSERT OR IGNORE INTO processed_expense_confirmations (message_key, processed_at)
      VALUES (?, ?)
    `);
    this.insertAuthoritativeReply = this.database.prepare(`
      INSERT OR IGNORE INTO pending_authoritative_replies
        (reply_key, delivery_key, recipient_key, text, expires_at, source_message_key)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.insertRealInboundHistory = this.database.prepare(`
      INSERT OR IGNORE INTO real_inbound_message_history (message_key, observed_at)
      VALUES (?, ?)
    `);
    this.updateLatestReplySource = this.database.prepare(`
      INSERT INTO latest_recipient_messages (recipient_key, message_key) VALUES (?, ?)
      ON CONFLICT(recipient_key) DO UPDATE SET message_key = excluded.message_key
    `);
    this.updateLatestProposalSource = this.database.prepare(`
      INSERT INTO latest_substantive_messages (conversation_key, message_key) VALUES (?, ?)
      ON CONFLICT(conversation_key) DO UPDATE SET message_key = excluded.message_key
    `);
    this.selectLatestReplySource = this.database.prepare(`
      SELECT message_key FROM latest_recipient_messages WHERE recipient_key = ?
    `);
    this.selectLatestProposalSource = this.database.prepare(`
      SELECT message_key FROM latest_substantive_messages WHERE conversation_key = ?
    `);
    this.deleteOutdatedAuthoritativeReplies = this.database.prepare(`
      DELETE FROM pending_authoritative_replies
      WHERE EXISTS (
        SELECT 1 FROM latest_recipient_messages AS latest
        WHERE latest.recipient_key = pending_authoritative_replies.recipient_key
          AND (pending_authoritative_replies.source_message_key IS NULL
            OR pending_authoritative_replies.source_message_key <> latest.message_key)
      )
    `);
    this.deleteExpiredAuthoritativeReplies = this.database.prepare(`
      DELETE FROM pending_authoritative_replies
      WHERE expires_at < ?
    `);
    this.selectReservedAuthoritativeReplies = this.database.prepare(`
      SELECT reply_key, delivery_key, recipient_key, text
      FROM pending_authoritative_replies
      WHERE reserved_by = ? AND expires_at >= ?
      ORDER BY reply_key
    `);
    this.selectAuthoritativeRepliesByDelivery = this.database.prepare(`
      SELECT reply_key, text
      FROM pending_authoritative_replies
      WHERE delivery_key = ? AND reserved_by IS NULL AND expires_at >= ?
      ORDER BY reply_key
    `);
    this.selectAuthoritativeRepliesByRecipient = this.database.prepare(`
      SELECT reply_key, text
      FROM pending_authoritative_replies
      WHERE recipient_key = ? AND reserved_by IS NULL AND expires_at >= ?
      ORDER BY reply_key
    `);
    this.reserveAuthoritativeReply = this.database.prepare(`
      UPDATE pending_authoritative_replies
      SET reserved_by = ?, reserved_at = ?
      WHERE reply_key = ? AND reserved_by IS NULL AND expires_at >= ?
    `);
    this.selectCompletedAuthoritativeReplies = this.database.prepare(`
      SELECT reply_key
      FROM pending_authoritative_replies
      WHERE reserved_by = ?
      ORDER BY reply_key
    `);
    this.deleteCompletedAuthoritativeReplies = this.database.prepare(`
      DELETE FROM pending_authoritative_replies
      WHERE reserved_by = ?
    `);
    this.releaseAuthoritativeReplies = this.database.prepare(`
      UPDATE pending_authoritative_replies
      SET reserved_by = NULL, reserved_at = NULL
      WHERE reserved_by = ?
    `);
  }

  claim(key, image) {
    if (image) return this.#withImmediateTransaction(() => {
      const keys = [image.attachmentKey, ...(!image.confirmed && image.orderKey ? [image.orderKey] : [])];
      for (const evidenceKey of keys) {
        const link = this.database.prepare('SELECT receipt_key FROM image_expense_links WHERE evidence_key = ?').get(evidenceKey);
        if (link && link.receipt_key !== key) {
          const row = this.selectReceipt.get(link.receipt_key);
          return { ...(row ? JSON.parse(row.payload_json) : { status: 'unknown' }), imageDuplicate: true };
        }
      }
      const existing = this.claim(key);
      if (!existing) for (const evidenceKey of [image.attachmentKey, ...(image.orderKey ? [image.orderKey] : [])]) {
        this.database.prepare('INSERT OR IGNORE INTO image_expense_links VALUES (?, ?)').run(evidenceKey, key);
      }
      return existing;
    });
    const result = this.insertPending.run(key, Date.now());
    if (Number(result.changes) === 1) return null;
    const existing = this.selectReceipt.get(key);
    return existing ? JSON.parse(existing.payload_json) : { status: 'unknown' };
  }

  complete(key, payload) {
    this.#update(key, 'created', payload);
  }

  imageOrderNeedsConfirmation({ attachmentKey, orderKey }) {
    const find = this.database.prepare('SELECT receipt_key FROM image_expense_links WHERE evidence_key = ?');
    return Boolean(orderKey && !find.get(attachmentKey) && find.get(orderKey));
  }

  imageReceipt(attachmentKey) {
    return this.imageReceiptLink(attachmentKey)?.receipt;
  }

  receipt(key) {
    const row = this.selectReceipt.get(key);
    return row ? JSON.parse(row.payload_json) : undefined;
  }

  imageReceiptLink(evidenceKey) {
    const link = this.database.prepare('SELECT receipt_key FROM image_expense_links WHERE evidence_key = ?').get(evidenceKey);
    if (!link) return undefined;
    return { receiptKey: link.receipt_key, receipt: this.receipt(link.receipt_key) ?? { status: 'unknown' } };
  }

  releaseDeletedImageLinks({ receiptKey, receipt }) {
    return this.#withImmediateTransaction(() => {
      const current = this.receipt(receiptKey);
      if (receipt?.status !== 'created' || !receipt.transactionId
        || JSON.stringify(current) !== JSON.stringify(receipt)) return false;
      // The original message and confirmation tombstones stay permanent. Only
      // links still owned by this exact, verified-deleted write can be retired.
      this.database.prepare('DELETE FROM image_expense_links WHERE receipt_key = ?').run(receiptKey);
      return true;
    });
  }

  fail(key, payload) {
    this.#update(key, 'failed', payload);
  }

  uncertain(key, payload) {
    this.#update(key, 'unknown', { ...payload, status: 'unknown' });
  }

  replacePendingExpenseConfirmation(conversationKey, proposal, expiresAt, now = Date.now()) {
    const normalized = normalizePendingExpenseProposal(proposal);
    if (!HASH_KEY_PATTERN.test(String(conversationKey ?? ''))
      || !Number.isSafeInteger(expiresAt) || expiresAt <= 0
      || !Number.isSafeInteger(now) || now <= 0
      || !normalized || normalized.sourceInbound.conversationKey !== conversationKey) {
      throw new Error('pending expense confirmation is invalid');
    }
    return this.#withImmediateTransaction(() => {
      if (!this.isCurrentExpenseProposalSource({ conversationKey, sourceMessageKey: normalized.sourceMessageKey })) return false;
      this.upsertPendingExpenseConfirmation.run(
        conversationKey,
        JSON.stringify(normalized),
        expiresAt,
        now,
      );
      return true;
    });
  }

  storeImageProposal(conversationKey, proposal, expiresAt, now = Date.now()) {
    const normalized = normalizePendingExpenseProposal(proposal);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || !HASH_KEY_PATTERN.test(conversationKey)
      || !normalized?.sourceInbound.image || normalized.sourceInbound.conversationKey !== conversationKey
      || !this.database.prepare('SELECT 1 FROM real_inbound_message_history WHERE message_key = ?').get(proposal.sourceMessageKey)) {
      throw new Error('invalid image proposal source');
    }
    return this.#withImmediateTransaction(() => {
      const existing = this.database.prepare('SELECT id, status, expires_at FROM image_expense_proposals WHERE source_message_key = ?').get(proposal.sourceMessageKey);
      if (existing) return existing.status === 'active' && existing.expires_at >= now ? { id: existing.id } : { status: 'expired' };
      const active = this.database.prepare("SELECT id, payload_json FROM image_expense_proposals WHERE conversation_key = ? AND status = 'active' AND expires_at >= ?").all(conversationKey, now);
      const duplicate = active.find(row => JSON.parse(row.payload_json).sourceInbound?.image?.sha256 === normalized.sourceInbound.image.sha256);
      if (duplicate) return { id: duplicate.id, status: 'duplicate' };
      const count = this.database.prepare("SELECT count(*) AS n FROM image_expense_proposals WHERE conversation_key = ? AND status = 'active' AND expires_at >= ?").get(conversationKey, now).n;
      if (count >= 10) return { status: 'full' };
      const row = this.database.prepare('INSERT INTO image_expense_proposals (conversation_key,source_message_key,payload_json,expires_at) VALUES (?,?,?,?)')
        .run(conversationKey, proposal.sourceMessageKey, JSON.stringify(normalized), expiresAt);
      return { id: Number(row.lastInsertRowid) };
    });
  }

  consumeImageOrTextConfirmation(conversationKey, confirmationMessageKey, proposalId, now = Date.now()) {
    if (!HASH_KEY_PATTERN.test(conversationKey) || !HASH_KEY_PATTERN.test(confirmationMessageKey)
      || (proposalId !== undefined && (!Number.isSafeInteger(proposalId) || proposalId < 1))) throw new Error('invalid image confirmation');
    return this.#withImmediateTransaction(() => {
      const rows = this.database.prepare("SELECT * FROM image_expense_proposals WHERE conversation_key = ? AND status = 'active' AND expires_at >= ?").all(conversationKey, now);
      const text = this.selectPendingExpenseConfirmation.get(conversationKey);
      if (proposalId === undefined && !rows.length) return this.consumePendingExpenseConfirmationUnlocked(conversationKey, confirmationMessageKey, now);
      if (proposalId === undefined && rows.length + (text?.expires_at >= now ? 1 : 0) !== 1) return { status: 'ambiguous', ids: rows.map(r => r.id) };
      const claimed = this.insertProcessedExpenseConfirmation.run(confirmationMessageKey, now);
      if (Number(claimed.changes) !== 1) return { status: 'duplicate' };
      const row = proposalId === undefined ? rows[0] : this.database.prepare('SELECT * FROM image_expense_proposals WHERE id = ? AND conversation_key = ?').get(proposalId, conversationKey);
      if (!row || row.status !== 'active') return { status: 'missing' };
      this.database.prepare("UPDATE image_expense_proposals SET status = 'consumed' WHERE id = ?").run(row.id);
      if (row.expires_at < now) return { status: 'expired' };
      const proposal = normalizePendingExpenseProposal(JSON.parse(row.payload_json));
      return proposal?.sourceInbound.image ? { status: 'active', proposal } : { status: 'missing' };
    });
  }

  consumePendingExpenseConfirmationUnlocked(conversationKey, messageKey, now) {
    const claimed = this.insertProcessedExpenseConfirmation.run(messageKey, now);
    if (Number(claimed.changes) !== 1) return { status: 'duplicate' };
    return this.#takePendingExpenseConfirmation(conversationKey, now);
  }

  takePendingExpenseConfirmation(conversationKey, now = Date.now()) {
    if (!HASH_KEY_PATTERN.test(String(conversationKey ?? ''))
      || !Number.isSafeInteger(now) || now <= 0) {
      throw new Error('pending expense confirmation lookup is invalid');
    }
    return this.#withImmediateTransaction(() => this.#takePendingExpenseConfirmation(conversationKey, now));
  }

  consumePendingExpenseConfirmation(conversationKey, confirmationMessageKey, now = Date.now()) {
    if (!HASH_KEY_PATTERN.test(String(conversationKey ?? ''))
      || !HASH_KEY_PATTERN.test(String(confirmationMessageKey ?? ''))
      || !Number.isSafeInteger(now) || now <= 0) {
      throw new Error('expense confirmation consumption is invalid');
    }
    return this.#withImmediateTransaction(() => {
      // Keep this hashed tombstone even when no proposal exists or the later API write fails.
      // Redelivery of an old confirmation must never consume a subsequent proposal.
      const claimed = this.insertProcessedExpenseConfirmation.run(confirmationMessageKey, now);
      if (Number(claimed.changes) !== 1) return { status: 'duplicate' };
      return this.#takePendingExpenseConfirmation(conversationKey, now);
    });
  }

  #takePendingExpenseConfirmation(conversationKey, now) {
    const row = this.selectPendingExpenseConfirmation.get(conversationKey);
    if (!row) return { status: 'missing' };
    this.deletePendingExpenseConfirmation.run(conversationKey);
    if (!Number.isSafeInteger(row.expires_at) || row.expires_at < now) {
      return { status: 'expired' };
    }
    let proposal;
    try {
      proposal = normalizePendingExpenseProposal(JSON.parse(row.payload_json));
    } catch {
      proposal = undefined;
    }
    return proposal && this.isCurrentExpenseProposalSource({ conversationKey, sourceMessageKey: proposal.sourceMessageKey })
      ? { status: 'active', proposal }
      : { status: 'missing' };
  }

  discardPendingExpenseConfirmation(conversationKey) {
    if (!HASH_KEY_PATTERN.test(String(conversationKey ?? ''))) {
      throw new Error('pending expense confirmation lookup is invalid');
    }
    return Number(this.deletePendingExpenseConfirmation.run(conversationKey).changes) === 1;
  }

  isCurrentReplySource({ recipientKey, sourceMessageKey }) {
    if (!HASH_KEY_PATTERN.test(String(recipientKey ?? ''))
      || (sourceMessageKey !== undefined && !HASH_KEY_PATTERN.test(String(sourceMessageKey)))) {
      throw new Error('authoritative reply source is invalid');
    }
    const latest = this.selectLatestReplySource.get(recipientKey);
    return !latest || latest.message_key === sourceMessageKey;
  }

  isCurrentExpenseProposalSource({ conversationKey, sourceMessageKey }) {
    if (!HASH_KEY_PATTERN.test(String(conversationKey ?? ''))
      || (sourceMessageKey !== undefined && !HASH_KEY_PATTERN.test(String(sourceMessageKey)))) {
      throw new Error('pending expense confirmation source is invalid');
    }
    const latest = this.selectLatestProposalSource.get(conversationKey);
    return !latest || latest.message_key === sourceMessageKey;
  }

  storeAuthoritativeReply({ replyKey, deliveryKey, recipientKey, text, expiresAt, sourceMessageKey }) {
    if (!HASH_KEY_PATTERN.test(String(replyKey ?? ''))
      || !HASH_KEY_PATTERN.test(String(deliveryKey ?? ''))
      || !HASH_KEY_PATTERN.test(String(recipientKey ?? ''))
      || (sourceMessageKey !== undefined && !HASH_KEY_PATTERN.test(String(sourceMessageKey)))
      || typeof text !== 'string' || text.length === 0
      || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      throw new Error('authoritative reply is invalid');
    }
    return this.#withImmediateTransaction(() => {
      if (!this.isCurrentReplySource({ recipientKey, sourceMessageKey })) return false;
      this.deleteExpiredAuthoritativeReplies.run(Date.now());
      this.insertAuthoritativeReply.run(replyKey, deliveryKey, recipientKey, text, expiresAt, sourceMessageKey ?? null);
      return true;
    });
  }

  reserveUniqueAuthoritativeReply({ deliveryKey, recipientKey, outboundRunKey }, now = Date.now()) {
    if ((deliveryKey !== undefined && !HASH_KEY_PATTERN.test(String(deliveryKey)))
      || !HASH_KEY_PATTERN.test(String(recipientKey ?? ''))
      || !HASH_KEY_PATTERN.test(String(outboundRunKey ?? ''))
      || !Number.isSafeInteger(now) || now <= 0) {
      throw new Error('authoritative reply reservation is invalid');
    }
    return this.#withImmediateTransaction(() => {
      this.deleteExpiredAuthoritativeReplies.run(now);
      this.deleteOutdatedAuthoritativeReplies.run();
      const existing = this.selectReservedAuthoritativeReplies.all(outboundRunKey, now);
      if (existing.length === 1) {
        const [reserved] = existing;
        const matchesRecipient = deliveryKey === undefined
          ? reserved.recipient_key === recipientKey
          : reserved.delivery_key === deliveryKey;
        return matchesRecipient
          ? { reply_key: reserved.reply_key, text: reserved.text }
          : undefined;
      }
      if (existing.length > 1) return undefined;
      const candidates = deliveryKey === undefined
        ? this.selectAuthoritativeRepliesByRecipient.all(recipientKey, now)
        : this.selectAuthoritativeRepliesByDelivery.all(deliveryKey, now);
      if (candidates.length !== 1) return undefined;
      const [candidate] = candidates;
      const reserved = this.reserveAuthoritativeReply.run(
        outboundRunKey,
        now,
        candidate.reply_key,
        now,
      );
      return Number(reserved.changes) === 1 ? candidate : undefined;
    });
  }

  finishAuthoritativeReplyDelivery(outboundRunKey, success) {
    if (!HASH_KEY_PATTERN.test(String(outboundRunKey ?? '')) || typeof success !== 'boolean') {
      throw new Error('authoritative reply completion is invalid');
    }
    return this.#withImmediateTransaction(() => {
      if (!success) {
        this.releaseAuthoritativeReplies.run(outboundRunKey);
        return [];
      }
      const completed = this.selectCompletedAuthoritativeReplies.all(outboundRunKey);
      this.deleteCompletedAuthoritativeReplies.run(outboundRunKey);
      return completed.map((row) => row.reply_key);
    });
  }

  endTrustedRun(runKey, now = Date.now()) {
    if (!HASH_KEY_PATTERN.test(String(runKey ?? ''))
      || !Number.isSafeInteger(now) || now <= 0
      || !Number.isSafeInteger(now + TRUSTED_RUN_END_TTL_MS)) {
      throw new Error('ended trusted run is invalid');
    }
    this.#withImmediateTransaction(() => {
      this.deleteExpiredEndedTrustedRuns.run(now);
      this.upsertEndedTrustedRun.run(runKey, now + TRUSTED_RUN_END_TTL_MS);
    });
  }

  isTrustedRunEnded(runKey, now = Date.now()) {
    if (!HASH_KEY_PATTERN.test(String(runKey ?? '')) || !Number.isSafeInteger(now) || now <= 0) {
      throw new Error('ended trusted run lookup is invalid');
    }
    this.deleteExpiredEndedTrustedRuns.run(now);
    return this.selectEndedTrustedRun.get(runKey, now) !== undefined;
  }

  enqueueTrustedInbound(lookupKeys, messageKey, payload, expiresAt, {
    discardPendingConfirmation = false,
    isRealInbound = false,
  } = {}) {
    const keys = [...new Set(lookupKeys.filter((key) => typeof key === 'string' && key.length > 0))];
    if (keys.length === 0 || typeof messageKey !== 'string' || messageKey.length === 0) return;
    if (typeof discardPendingConfirmation !== 'boolean' || typeof isRealInbound !== 'boolean'
      || (discardPendingConfirmation && !HASH_KEY_PATTERN.test(String(payload?.conversationKey ?? '')))) {
      throw new Error('trusted inbound confirmation invalidation is invalid');
    }
    if (isRealInbound && (!normalizeTrustedInboundPayload(payload)
      || !HASH_KEY_PATTERN.test(String(payload.conversationKey ?? ''))
      || !HASH_KEY_PATTERN.test(String(payload.recipientKey ?? ''))
      || !HASH_KEY_PATTERN.test(String(payload.deliveryKey ?? ''))
      || messageKey !== trustedInboundMessageKey(payload.channel, payload.messageId))) {
      throw new Error('real trusted inbound source is invalid');
    }
    const payloadJson = JSON.stringify(payload);
    this.#withImmediateTransaction(() => {
      this.#deleteExpiredTrustedInbound(Date.now());
      const inserted = this.insertTrustedInbound.run(messageKey, payloadJson, expiresAt);
      const isNewRealMessage = isRealInbound
        && Number(this.insertRealInboundHistory.run(messageKey, Date.now()).changes) === 1;
      if (isNewRealMessage) {
        this.updateLatestReplySource.run(payload.recipientKey, messageKey);
        this.deleteOutdatedAuthoritativeReplies.run();
        if (discardPendingConfirmation) {
          this.updateLatestProposalSource.run(payload.conversationKey, messageKey);
        }
      }
      if ((isRealInbound ? isNewRealMessage : Number(inserted.changes) === 1) && discardPendingConfirmation) {
        this.deletePendingExpenseConfirmation.run(payload.conversationKey);
      }
      const reactivated = Number(inserted.changes) === 1
        ? inserted
        : this.reactivateTrustedInbound.run(payloadJson, expiresAt, messageKey);
      if (Number(reactivated.changes) !== 1) return;
      for (const key of keys) this.insertTrustedInboundLookup.run(key, messageKey);
    });
  }

  claimTrustedInbound(lookupKeys, now = Date.now()) {
    const keys = [...new Set(lookupKeys.filter((key) => typeof key === 'string' && key.length > 0))];
    if (keys.length === 0) return undefined;
    const placeholders = keys.map(() => '?').join(', ');
    const selectOldest = this.database.prepare(`
      SELECT queued.message_key, queued.payload_json
      FROM trusted_inbound_queue AS queued
      WHERE queued.claimed_at IS NULL
        AND queued.expires_at >= ?
        AND EXISTS (
          SELECT 1 FROM trusted_inbound_queue_lookups AS lookup
          WHERE lookup.message_key = queued.message_key
            AND lookup.lookup_key IN (${placeholders})
        )
      ORDER BY queued.arrival_order ASC
      LIMIT 1
    `);
    const claimed = this.#withImmediateTransaction(() => {
      this.#deleteExpiredTrustedInbound(now);
      const existing = selectOldest.get(now, ...keys);
      if (!existing) return undefined;
      const result = this.claimTrustedInboundMessage.run(now, existing.message_key);
      return Number(result.changes) === 1 ? existing.payload_json : undefined;
    });
    return claimed === undefined ? undefined : JSON.parse(claimed);
  }

  claimUniqueTrustedInboundMatching(lookupKeys, predicate, now = Date.now()) {
    const keys = [...new Set(lookupKeys.filter((key) => typeof key === 'string' && key.length > 0))];
    if (keys.length === 0 || typeof predicate !== 'function') return undefined;
    const placeholders = keys.map(() => '?').join(', ');
    const selectCandidates = this.database.prepare(`
      SELECT queued.message_key, queued.payload_json
      FROM trusted_inbound_queue AS queued
      WHERE queued.claimed_at IS NULL
        AND queued.expires_at >= ?
        AND EXISTS (
          SELECT 1 FROM trusted_inbound_queue_lookups AS lookup
          WHERE lookup.message_key = queued.message_key
            AND lookup.lookup_key IN (${placeholders})
        )
      ORDER BY queued.arrival_order ASC
    `);
    const claimed = this.#withImmediateTransaction(() => {
      this.#deleteExpiredTrustedInbound(now);
      const matches = [];
      for (const existing of selectCandidates.all(now, ...keys)) {
        let payload;
        try {
          payload = JSON.parse(existing.payload_json);
        } catch {
          continue;
        }
        if (predicate(payload)) matches.push(existing);
      }
      if (matches.length !== 1) return undefined;
      const [existing] = matches;
      const result = this.claimTrustedInboundMessage.run(now, existing.message_key);
      return Number(result.changes) === 1 ? existing.payload_json : undefined;
    });
    return claimed === undefined ? undefined : JSON.parse(claimed);
  }

  #deleteExpiredTrustedInbound(now) {
    this.deleteExpiredTrustedInboundLookups.run(now);
    this.deleteExpiredTrustedInboundMessages.run(now);
  }

  #migrateLegacyTrustedInboundMessages() {
    this.#withImmediateTransaction(() => {
      const legacyTable = this.database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'trusted_inbound_messages'
      `).get();
      if (!legacyTable) return;

      const now = Date.now();
      const groups = new Map();
      for (const row of this.database.prepare(`
        SELECT lookup_key, payload_json, expires_at FROM trusted_inbound_messages
        WHERE typeof(lookup_key) = 'text'
          AND typeof(payload_json) = 'text'
          AND typeof(expires_at) = 'integer'
          AND expires_at BETWEEN ? AND 9007199254740991
      `).all(now)) {
        if (typeof row.lookup_key !== 'string' || row.lookup_key.length === 0
          || typeof row.payload_json !== 'string'
          || !Number.isSafeInteger(row.expires_at)) continue;
        let parsed;
        try {
          parsed = JSON.parse(row.payload_json);
        } catch {
          continue;
        }
        const payload = normalizeTrustedInboundPayload(parsed);
        if (!payload) continue;
        const messageKey = trustedInboundMessageKey(payload.channel, payload.messageId);
        const payloadJson = JSON.stringify(payload);
        const existing = groups.get(messageKey);
        if (existing && existing.payloadJson !== payloadJson) {
          existing.conflicted = true;
          continue;
        }
        const group = existing ?? {
          messageKey,
          payloadJson,
          expiresAt: row.expires_at,
          observedAt: payload.observedAt,
          lookupKeys: new Set(),
          conflicted: false,
        };
        group.expiresAt = Math.max(group.expiresAt, row.expires_at);
        group.lookupKeys.add(row.lookup_key);
        groups.set(messageKey, group);
      }

      const insertMessage = this.database.prepare(`
        INSERT OR IGNORE INTO trusted_inbound_queue (message_key, payload_json, expires_at)
        VALUES (?, ?, ?)
      `);
      const insertLookup = this.database.prepare(`
        INSERT OR IGNORE INTO trusted_inbound_queue_lookups (lookup_key, message_key)
        VALUES (?, ?)
      `);
      const orderedGroups = [...groups.values()].sort(
        (left, right) => left.observedAt - right.observedAt
          || left.messageKey.localeCompare(right.messageKey),
      );
      for (const group of orderedGroups) {
        if (group.conflicted) continue;
        const inserted = insertMessage.run(group.messageKey, group.payloadJson, group.expiresAt);
        if (Number(inserted.changes) !== 1) continue;
        for (const lookupKey of group.lookupKeys) insertLookup.run(lookupKey, group.messageKey);
      }
      this.database.exec('DROP TABLE trusted_inbound_messages');
    });
  }

  #migrateProcessedExpenseConfirmations() {
    this.#withImmediateTransaction(() => {
      const applied = this.database.prepare(`
        SELECT 1 FROM receipt_store_migrations WHERE migration_key = ?
      `).get(CONFIRMATION_HISTORY_MIGRATION_KEY);
      if (applied) return;

      // Old claimed payloads have already been scrubbed, so conservatively block
      // those message hashes from ever confirming a later proposal after upgrade.
      const now = Date.now();
      this.database.prepare(`
        INSERT OR IGNORE INTO processed_expense_confirmations (message_key, processed_at)
        SELECT message_key, ? FROM trusted_inbound_queue
        WHERE claimed_at IS NOT NULL
          AND length(message_key) = 64
          AND message_key NOT GLOB '*[^a-f0-9]*'
      `).run(now);
      this.database.prepare(`
        INSERT INTO receipt_store_migrations (migration_key, applied_at) VALUES (?, ?)
      `).run(CONFIRMATION_HISTORY_MIGRATION_KEY, now);
    });
  }

  #migrateInboundFreshness() {
    this.#withImmediateTransaction(() => {
      const applied = this.database.prepare(`
        SELECT 1 FROM receipt_store_migrations WHERE migration_key = ?
      `).get(INBOUND_FRESHNESS_MIGRATION_KEY);
      if (applied) return;

      this.database.exec(`
        CREATE TABLE IF NOT EXISTS real_inbound_message_history (
          message_key TEXT PRIMARY KEY,
          observed_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS latest_recipient_messages (
          recipient_key TEXT PRIMARY KEY,
          message_key TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS latest_substantive_messages (
          conversation_key TEXT PRIMARY KEY,
          message_key TEXT NOT NULL
        );
      `);
      const replyColumns = this.database.prepare('PRAGMA table_info(pending_authoritative_replies)').all();
      if (!replyColumns.some((column) => column.name === 'source_message_key')) {
        this.database.exec('ALTER TABLE pending_authoritative_replies ADD COLUMN source_message_key TEXT');
      }
      const now = Date.now();
      // Remember pre-upgrade hashes so an old delivery cannot become "new" again.
      // Scrubbed payloads cannot establish a reliable latest source; legacy state
      // remains usable until its recipient/conversation receives a new real message.
      this.database.prepare(`
        INSERT OR IGNORE INTO real_inbound_message_history (message_key, observed_at)
        SELECT message_key, ? FROM trusted_inbound_queue
        WHERE length(message_key) = 64 AND message_key NOT GLOB '*[^a-f0-9]*'
      `).run(now);
      this.database.prepare(`
        INSERT INTO receipt_store_migrations (migration_key, applied_at) VALUES (?, ?)
      `).run(INBOUND_FRESHNESS_MIGRATION_KEY, now);
    });
  }

  #withImmediateTransaction(action) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original storage failure.
      }
      throw error;
    }
  }

  #update(key, status, payload) {
    this.updateReceipt.run(status, JSON.stringify(payload), Date.now(), key);
  }

  close() {
    this.database.close();
  }
}

export class EzBookkeepingApi {
  constructor({
    serverBaseUrl,
    tokenPath,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    exchangeRateSource = 'ezbookkeeping',
    deployment = PRODUCTION_DEPLOYMENT,
  }) {
    assertDeploymentOrigin(serverBaseUrl, deployment);
    const parsed = new URL(serverBaseUrl);
    if (parsed.protocol !== 'http:'
      || parsed.hostname !== '127.0.0.1'
      || parsed.port !== new URL(deployment.origin).port
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash) {
      throw new Error('bookkeeping server must be the fixed loopback endpoint http://127.0.0.1:8888');
    }
    if (!Number.isSafeInteger(requestTimeoutMs)
      || requestTimeoutMs < 1
      || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      throw new Error('bookkeeping request timeout must be an integer from 1 to 60000 milliseconds');
    }
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.tokenPath = tokenPath;
    this.fetch = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    if (!['ezbookkeeping', 'bank_of_china_spot_sell'].includes(exchangeRateSource)) throw new Error('unsupported rate source');
    this.exchangeRateSource = exchangeRateSource;
  }

  async #request(path, { method = 'GET', body, query, allowTransactionNotFound = false } = {}) {
    let token;
    try {
      token = readFileSync(this.tokenPath, 'utf8').trim();
      if (!token) throw new Error('empty credential');
    } catch {
      throw new Error('ezBookkeeping credential unavailable');
    }
    const url = new URL(`/api/v1/${path}`, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && String(value) !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    const controller = new AbortController();
    const timeoutError = new Error('ezBookkeeping request timed out');
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(timeoutError);
        controller.abort();
      }, this.requestTimeoutMs);
    });
    try {
      const response = await Promise.race([
        Promise.resolve(this.fetch(url.toString(), {
          method,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
            'X-Timezone-Name': 'Asia/Singapore',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })).catch((error) => {
          if (controller.signal.aborted) throw timeoutError;
          throw error;
        }),
        timeout,
      ]);
      const payload = await Promise.race([response.json(), timeout]);
      // ezBookkeeping v1.6.1 ErrTransactionNotFound. Other HTTP 400 responses
      // (including timezone/auth errors) cannot establish that a row was deleted.
      if (allowTransactionNotFound && method === 'GET' && path === 'transactions/get.json'
        && response.status === 400 && payload?.success === false
        && payload.errorCode === 205001 && payload.errorMessage === 'transaction not found'
        && payload.result === undefined) return TRANSACTION_NOT_FOUND;
      if (!response.ok || payload.success !== true) {
        throw new Error(`ezBookkeeping request failed (HTTP ${response.status})`);
      }
      return payload.result;
    } catch (error) {
      if (error === timeoutError || controller.signal.aborted) throw timeoutError;
      if (error instanceof Error && /^ezBookkeeping request failed \(HTTP \d+\)$/u.test(error.message)) {
        throw error;
      }
      throw new Error('ezBookkeeping request failed');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async health() {
    const [version, accounts, categories] = await Promise.all([
      this.#request('systems/version.json'),
      this.#request('accounts/list.json'),
      this.#request('transaction/categories/list.json'),
    ]);
    const expenseCategories = Array.isArray(categories?.['2']) ? categories['2'] : [];
    return {
      version: version.version,
      accountCount: Array.isArray(accounts) ? accounts.length : 0,
      primaryExpenseCategoryCount: expenseCategories.length,
      secondaryExpenseCategoryCount: expenseCategories.reduce(
        (count, category) => count + (Array.isArray(category.subCategories) ? category.subCategories.length : 0),
        0,
      ),
    };
  }

  async listExpenseAccounts(name = '日常支出') {
    return scopedExpenseAccounts(await this.#request('accounts/list.json'), name);
  }

  async resolveAccountId(name, currency = 'SGD') {
    return selectExpenseWriteAccount(await this.listExpenseAccounts(name), currency).id;
  }

  async getExchangeRates() {
    return this.exchangeRateCache ? this.exchangeRateCache.get() : this.getUncachedExchangeRates();
  }

  async getUncachedExchangeRates() {
    if (this.exchangeRateSource === 'bank_of_china_spot_sell') {
      return fetchBankOfChinaSpotSell({ fetchImpl: this.fetch, timeoutMs: this.requestTimeoutMs });
    }
    return validateExchangeRates(await this.#request('exchange_rates/latest.json'));
  }

  async resolveExpenseCategoryId(primaryName, subcategoryName) {
    const categories = await this.#request('transaction/categories/list.json');
    const primaryMatches = (Array.isArray(categories?.['2']) ? categories['2'] : []).filter(
      (category) => category.name === primaryName && category.parentId === '0' && category.hidden !== true,
    );
    if (primaryMatches.length !== 1) {
      throw new Error(`expected exactly one expense category named ${primaryName}; found ${primaryMatches.length}`);
    }
    const secondaryMatches = (Array.isArray(primaryMatches[0].subCategories)
      ? primaryMatches[0].subCategories
      : []).filter((category) => category.name === subcategoryName && category.hidden !== true);
    if (secondaryMatches.length !== 1) {
      throw new Error(`expected exactly one subcategory ${primaryName}/${subcategoryName}; found ${secondaryMatches.length}`);
    }
    return secondaryMatches[0].id;
  }

  async listExpenseCategories() {
    const categories = await this.#request('transaction/categories/list.json');
    if (!Array.isArray(categories?.['2'])) {
      throw new Error('expense category list response is invalid');
    }
    return categories['2'];
  }

  async resolveExpenseCategoryFilterId(primaryName, subcategoryName, preloadedCategories) {
    if (!primaryName) return undefined;
    const categories = preloadedCategories ?? await this.listExpenseCategories();
    const primaryMatches = categories.filter(
      (category) => category?.name === primaryName && category.parentId === '0' && category.hidden !== true,
    );
    if (primaryMatches.length !== 1) {
      throw new Error(`expected exactly one expense category named ${primaryName}; found ${primaryMatches.length}`);
    }
    if (!subcategoryName) return primaryMatches[0].id;
    const secondaryMatches = (Array.isArray(primaryMatches[0].subCategories)
      ? primaryMatches[0].subCategories
      : []).filter(
      (category) => category?.name === subcategoryName
        && category.parentId === primaryMatches[0].id
        && category.hidden !== true,
    );
    if (secondaryMatches.length !== 1) {
      throw new Error(`expected exactly one subcategory ${primaryName}/${subcategoryName}; found ${secondaryMatches.length}`);
    }
    return secondaryMatches[0].id;
  }

  async listExpenseTransactions({ accountId, startTime, endTime, categoryId, keyword } = {}) {
    const transactions = await this.#request('transactions/list/all.json', {
      query: {
        type: 3,
        account_ids: accountId,
        category_ids: categoryId,
        start_time: startTime,
        end_time: endTime,
        keyword,
        trim_account: true,
        trim_tag: true,
      },
    });
    if (!Array.isArray(transactions)) {
      throw new Error('expense transaction list response is invalid');
    }
    return transactions.map((transaction) => {
      const sanitized = sanitizeExpenseTransaction(transaction);
      if (transaction.sourceAccountId !== undefined && transaction.sourceAccountId !== accountId) {
        throw new Error('expense transaction is outside the requested account');
      }
      if (sanitized.time < startTime || sanitized.time > endTime) throw new Error('expense transaction is outside the requested time range');
      return sanitized;
    });
  }

  async findExpenseTransactions({ accountId, amountMinor, startTime, endTime, limit = 3 } = {}) {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('expense search parameters are invalid');
    return this.#listExpensePage({ accountId, amountMinor, startTime, endTime, limit });
  }

  async listScopedExpenseTransactions({ accounts, startTime, endTime, categoryId, keyword }) {
    if (!Array.isArray(accounts) || !accounts.length || accounts.length > 160
      || accounts.some((a) => typeof a?.id !== 'string' || !a.id || a.id === '0' || /[,\s]/u.test(a.id) || normalizeCurrency(a.currency) !== a.currency)
      || new Set(accounts.map((a) => a.id)).size !== accounts.length) throw new Error('invalid account scope');
    if (accounts.length === 1) {
      return (await this.listExpenseTransactions({ accountId: accounts[0].id, startTime, endTime, categoryId, keyword }))
        .map((row) => ({ ...row, currency: accounts[0].currency }));
    }
    const scope = new Map(accounts.map((a) => [a.id, a.currency]));
    const rows = await this.#request('transactions/list/all.json', { query: {
      type: 3, account_ids: accounts.map((a) => a.id).join(','), start_time: startTime, end_time: endTime,
      category_ids: categoryId, keyword, trim_account: true, trim_tag: true,
    } });
    if (!Array.isArray(rows)) throw new Error('invalid scoped expense response');
    return rows.map((row) => {
      const value = sanitizeExpenseTransaction(row);
      if (!scope.has(row.sourceAccountId) || value.time < startTime || value.time > endTime) throw new Error('expense outside account or time scope');
      return { ...value, currency: scope.get(row.sourceAccountId) };
    });
  }

  async listExpenseHistory({ accounts, startTime, endTime, limit = 3, keyword } = {}) {
    return this.#listExpensePage({ accounts, startTime, endTime, limit, keyword });
  }

  async #listExpensePage({ accountId, accounts, amountMinor, startTime, endTime, limit = 3, keyword } = {}) {
    const validBound = (value) => value === undefined || (
      Number.isSafeInteger(value) && value >= 0
      && Number.isSafeInteger(value * 1000 + 999)
      && Number.isFinite(new Date(value * 1000).getTime())
    );
    const scope = accounts ?? [{ id: accountId }];
    if (!Array.isArray(scope) || !scope.length || scope.length > 160
      || scope.some((a) => typeof a?.id !== 'string' || !a.id || a.id === '0' || /[,\s]/u.test(a.id))
      || new Set(scope.map((a) => a.id)).size !== scope.length
      || (amountMinor !== undefined && (!Number.isSafeInteger(amountMinor) || amountMinor <= 0))
      || (keyword !== undefined && (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 100))
      || !Number.isInteger(limit) || limit < 1 || limit > 10
      || !validBound(startTime) || !validBound(endTime)
      || (startTime !== undefined && endTime !== undefined && startTime > endTime)) {
      throw new Error('expense search parameters are invalid');
    }

    // v1.6.1 list.json uses transaction sequences, unlike list/all.json's Unix seconds.
    const minSequence = startTime === undefined ? undefined : startTime * 1000;
    const maxSequence = endTime === undefined ? 0 : endTime * 1000 + 999;
    const requestedCount = limit + 1;
    const result = await this.#request('transactions/list.json', {
      query: {
        type: 3,
        account_ids: scope.map((a) => a.id).join(','),
        amount_filter: amountMinor === undefined ? undefined : `eq:${amountMinor}`,
        keyword,
        max_time: maxSequence,
        min_time: minSequence,
        page: 1,
        count: requestedCount,
        trim_account: true,
        trim_tag: true,
      },
    });
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || !Array.isArray(result.items) || result.items.length > requestedCount
      || !Object.hasOwn(result, 'nextTimeSequenceId')) {
      throw new Error('expense search response is invalid');
    }

    const nextSequence = result.nextTimeSequenceId === null
      ? undefined : expenseSearchSequence(result.nextTimeSequenceId);
    if (result.items.length === 0 && nextSequence !== undefined) {
      throw new Error('expense search response is incomplete');
    }
    const seenIds = new Set();
    const rows = result.items.map((transaction) => {
      if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)
        || typeof transaction.id !== 'string' || !transaction.id
        || transaction.id.trim() !== transaction.id || seenIds.has(transaction.id)
        || !scope.some((a) => a.id === transaction.sourceAccountId)
        || (amountMinor !== undefined && transaction.sourceAmount !== amountMinor)
        || typeof transaction.categoryId !== 'string' || !transaction.categoryId.trim()
        || typeof transaction.comment !== 'string' || Array.from(transaction.comment).length > 255) {
        throw new Error('expense search response is invalid');
      }
      seenIds.add(transaction.id);
      let sanitized;
      try {
        sanitized = sanitizeExpenseTransaction(transaction);
      } catch {
        throw new Error('expense search response is invalid');
      }
      const sequence = expenseSearchSequence(transaction.timeSequenceId);
      if (sequence / 1000n !== BigInt(sanitized.time)
        || (startTime !== undefined && sanitized.time < startTime)
        || (endTime !== undefined && sanitized.time > endTime)) {
        throw new Error('expense search response is outside the requested time range');
      }
      return { sequence, transaction: { ...sanitized, comment: transaction.comment,
        ...(accounts ? { currency: scope.find((a) => a.id === transaction.sourceAccountId).currency } : {}) } };
    });
    rows.sort((left, right) => left.sequence === right.sequence ? 0 : left.sequence > right.sequence ? -1 : 1);
    if (nextSequence !== undefined && (
      nextSequence >= rows.at(-1).sequence
      || (minSequence !== undefined && nextSequence < BigInt(minSequence))
      || (maxSequence > 0 && nextSequence > BigInt(maxSequence))
    )) {
      throw new Error('expense search response has an invalid continuation');
    }
    return {
      transactions: rows.slice(0, limit).map((row) => row.transaction),
      hasMore: rows.length > limit || nextSequence !== undefined,
    };
  }

  async addTransaction(body) {
    return this.#request('transactions/add.json', { method: 'POST', body });
  }

  async transactionExists(transactionId) {
    if (typeof transactionId !== 'string' || !transactionId || transactionId.trim() !== transactionId
      || transactionId.length > 128 || /[\p{C}\p{Zl}\p{Zp}]/u.test(transactionId)) {
      throw new Error('invalid transaction lookup id');
    }
    const transaction = await this.#request('transactions/get.json', {
      query: { id: transactionId, with_pictures: false, trim_account: true, trim_category: true, trim_tag: true },
      allowTransactionNotFound: true,
    });
    if (transaction === TRANSACTION_NOT_FOUND) return false;
    if (!transaction || Array.isArray(transaction) || transaction.id !== transactionId) {
      throw new Error('transaction lookup response is invalid');
    }
    return true;
  }
}
