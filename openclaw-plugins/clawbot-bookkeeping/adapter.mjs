import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;

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

export class SqliteReceiptStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
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
    `);
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

  enqueueTrustedInbound(lookupKeys, messageKey, payload, expiresAt) {
    const keys = [...new Set(lookupKeys.filter((key) => typeof key === 'string' && key.length > 0))];
    if (keys.length === 0 || typeof messageKey !== 'string' || messageKey.length === 0) return;
    const payloadJson = JSON.stringify(payload);
    this.#withImmediateTransaction(() => {
      this.#deleteExpiredTrustedInbound(Date.now());
      const inserted = this.insertTrustedInbound.run(messageKey, payloadJson, expiresAt);
      if (Number(inserted.changes) !== 1) return;
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

  #deleteExpiredTrustedInbound(now) {
    this.deleteExpiredTrustedInboundLookups.run(now);
    this.deleteExpiredTrustedInboundMessages.run(now);
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
    const parsed = new URL(serverBaseUrl);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '8180') {
      throw new Error('bookkeeping server must be the fixed loopback endpoint http://127.0.0.1:8180');
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

  async addTransaction(body) {
    return this.#request('transactions/add.json', { method: 'POST', body });
  }
}
