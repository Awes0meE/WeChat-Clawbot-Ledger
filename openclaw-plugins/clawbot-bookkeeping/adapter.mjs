import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_BUSY_RETRY_MS = 10;
const TRUSTED_RUN_END_TTL_MS = 10 * 60 * 1000;
const CONFIRMATION_HISTORY_MIGRATION_KEY = 'processed-expense-confirmations-v1';
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
  const receivedTime = input.timeMode === 'received'
    && input.currency === 'SGD';
  const explicitTime = input.timeMode === 'explicit'
    && input.currency === 'SGD'
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
  return {
    sourceMessageKey: value.sourceMessageKey,
    resolvedTime: value.resolvedTime,
    sourceInbound: { ...sourceInbound, conversationKey },
    input: {
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
        (reply_key, delivery_key, recipient_key, text, expires_at)
      VALUES (?, ?, ?, ?, ?)
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

  claim(key) {
    const result = this.insertPending.run(key, Date.now());
    if (Number(result.changes) === 1) return null;
    const existing = this.selectReceipt.get(key);
    return existing ? JSON.parse(existing.payload_json) : { status: 'unknown' };
  }

  complete(key, payload) {
    this.#update(key, 'created', payload);
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
    this.upsertPendingExpenseConfirmation.run(
      conversationKey,
      JSON.stringify(normalized),
      expiresAt,
      now,
    );
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
    return proposal ? { status: 'active', proposal } : { status: 'missing' };
  }

  discardPendingExpenseConfirmation(conversationKey) {
    if (!HASH_KEY_PATTERN.test(String(conversationKey ?? ''))) {
      throw new Error('pending expense confirmation lookup is invalid');
    }
    return Number(this.deletePendingExpenseConfirmation.run(conversationKey).changes) === 1;
  }

  storeAuthoritativeReply({ replyKey, deliveryKey, recipientKey, text, expiresAt }) {
    if (!HASH_KEY_PATTERN.test(String(replyKey ?? ''))
      || !HASH_KEY_PATTERN.test(String(deliveryKey ?? ''))
      || !HASH_KEY_PATTERN.test(String(recipientKey ?? ''))
      || typeof text !== 'string' || text.length === 0
      || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      throw new Error('authoritative reply is invalid');
    }
    this.#withImmediateTransaction(() => {
      this.deleteExpiredAuthoritativeReplies.run(Date.now());
      this.insertAuthoritativeReply.run(replyKey, deliveryKey, recipientKey, text, expiresAt);
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

  enqueueTrustedInbound(lookupKeys, messageKey, payload, expiresAt, { discardPendingConfirmation = false } = {}) {
    const keys = [...new Set(lookupKeys.filter((key) => typeof key === 'string' && key.length > 0))];
    if (keys.length === 0 || typeof messageKey !== 'string' || messageKey.length === 0) return;
    if (typeof discardPendingConfirmation !== 'boolean'
      || (discardPendingConfirmation && !HASH_KEY_PATTERN.test(String(payload?.conversationKey ?? '')))) {
      throw new Error('trusted inbound confirmation invalidation is invalid');
    }
    const payloadJson = JSON.stringify(payload);
    this.#withImmediateTransaction(() => {
      this.#deleteExpiredTrustedInbound(Date.now());
      const inserted = this.insertTrustedInbound.run(messageKey, payloadJson, expiresAt);
      if (Number(inserted.changes) === 1 && discardPendingConfirmation) {
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
  }) {
    if (serverBaseUrl !== 'http://127.0.0.1:8888') {
      throw new Error('bookkeeping server must be the fixed loopback endpoint http://127.0.0.1:8888');
    }
    const parsed = new URL(serverBaseUrl);
    if (parsed.protocol !== 'http:'
      || parsed.hostname !== '127.0.0.1'
      || parsed.port !== '8888'
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
  }

  async #request(path, { method = 'GET', body, query } = {}) {
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

  async resolveAccountId(name) {
    const accounts = await this.#request('accounts/list.json');
    const matches = (Array.isArray(accounts) ? accounts : []).filter(
      (account) => account.name === name && account.currency === 'SGD' && account.hidden !== true,
    );
    if (matches.length !== 1) {
      throw new Error(`expected exactly one visible SGD account named ${name}; found ${matches.length}`);
    }
    return matches[0].id;
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
    return transactions.map(sanitizeExpenseTransaction);
  }

  async findExpenseTransactions({ accountId, amountMinor, startTime, endTime, limit = 3 } = {}) {
    const validBound = (value) => value === undefined || (
      Number.isSafeInteger(value) && value >= 0
      && Number.isSafeInteger(value * 1000 + 999)
      && Number.isFinite(new Date(value * 1000).getTime())
    );
    if (typeof accountId !== 'string' || !accountId || accountId.trim() !== accountId
      || accountId === '0' || /[,\s]/u.test(accountId)
      || !Number.isSafeInteger(amountMinor) || amountMinor <= 0
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
        account_ids: accountId,
        amount_filter: `eq:${amountMinor}`,
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
        || transaction.sourceAccountId !== accountId
        || transaction.sourceAmount !== amountMinor
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
      return { sequence, transaction: { ...sanitized, comment: transaction.comment } };
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
}
