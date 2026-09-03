import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
      CREATE TABLE IF NOT EXISTS trusted_inbound_messages (
        lookup_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
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
    this.upsertTrustedInbound = this.database.prepare(`
      INSERT INTO trusted_inbound_messages (lookup_key, payload_json, expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(lookup_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        expires_at = excluded.expires_at
    `);
    this.selectTrustedInbound = this.database.prepare(`
      SELECT payload_json FROM trusted_inbound_messages
      WHERE lookup_key = ? AND expires_at >= ?
    `);
    this.deleteExpiredTrustedInbound = this.database.prepare(`
      DELETE FROM trusted_inbound_messages WHERE expires_at < ?
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

  putTrustedInbound(lookupKeys, payload, expiresAt) {
    const keys = [...new Set(lookupKeys.filter((key) => typeof key === 'string' && key.length > 0))];
    if (keys.length === 0) return;
    const now = Date.now();
    this.deleteExpiredTrustedInbound.run(now);
    const payloadJson = JSON.stringify(payload);
    for (const key of keys) {
      this.upsertTrustedInbound.run(key, payloadJson, expiresAt);
    }
  }

  findTrustedInbound(lookupKeys, now = Date.now()) {
    this.deleteExpiredTrustedInbound.run(now);
    for (const key of lookupKeys) {
      if (typeof key !== 'string' || key.length === 0) continue;
      const existing = this.selectTrustedInbound.get(key, now);
      if (existing) return JSON.parse(existing.payload_json);
    }
    return undefined;
  }

  #update(key, status, payload) {
    this.updateReceipt.run(status, JSON.stringify(payload), Date.now(), key);
  }

  close() {
    this.database.close();
  }
}

export class EzBookkeepingApi {
  constructor({ serverBaseUrl, tokenPath, fetchImpl = globalThis.fetch }) {
    const parsed = new URL(serverBaseUrl);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '8180') {
      throw new Error('bookkeeping server must be the fixed loopback endpoint http://127.0.0.1:8180');
    }
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.tokenPath = tokenPath;
    this.fetch = fetchImpl;
  }

  async #request(path, { method = 'GET', body } = {}) {
    const token = readFileSync(this.tokenPath, 'utf8').trim();
    if (!token) throw new Error('ezBookkeeping API token file is empty');
    const response = await this.fetch(`${this.baseUrl}/api/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
        'X-Timezone-Name': 'Asia/Singapore',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok || payload.success !== true) {
      const code = payload?.errorCode ?? response.status;
      const message = payload?.errorMessage ?? response.statusText;
      throw new Error(`ezBookkeeping request failed (${code}): ${message}`);
    }
    return payload.result;
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

  async addTransaction(body) {
    return this.#request('transactions/add.json', { method: 'POST', body });
  }
}
