import { DatabaseSync } from 'node:sqlite';
import { validateBankOfChinaSnapshot } from './bank-of-china-rates.mjs';

export const singaporeDay = (nowMs) => new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10);
export function millisecondsUntilSingaporeMidnight(nowMs) {
  const local = nowMs + 8 * 3600_000;
  return Math.floor(local / 86400_000) * 86400_000 + 86400_000 - local;
}

// A small separate cache DB shares the receipts volume, not receipt authority
// tables. A single atomic daily claim prevents duplicate refreshes across the
// gateway and per-call Codex plugin instances. Failed attempts retain quotes.
export class DailyBankOfChinaRates {
  constructor({ path, load, now = Date.now, schedule = setTimeout, cancel = clearTimeout, logger }) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS daily_bank_rates (
        id INTEGER PRIMARY KEY CHECK (id=1), attempt_day TEXT NOT NULL,
        fetched_day TEXT, fetched_at INTEGER, payload TEXT
      );`);
    this.load = load; this.now = now; this.schedule = schedule; this.cancel = cancel; this.logger = logger;
  }
  read() {
    const row = this.db.prepare('SELECT * FROM daily_bank_rates WHERE id=1').get();
    if (!row?.payload) throw new Error('No successful bank quote is cached');
    const value = validateBankOfChinaSnapshot(JSON.parse(row.payload), this.now());
    return { ...value, fetchedAt: row.fetched_at,
      refreshFailed: row.fetched_day !== singaporeDay(this.now()), dailySnapshot: true };
  }
  async get() {
    if (this.closed) throw new Error('Rate cache is closed');
    if (this.pending) return this.pending;
    const day = singaporeDay(this.now());
    const claimed = this.db.prepare(`INSERT INTO daily_bank_rates (id, attempt_day) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET attempt_day=excluded.attempt_day
      WHERE daily_bank_rates.attempt_day < excluded.attempt_day RETURNING id`).get(day);
    if (!claimed) return this.read();
    this.pending = (async () => {
      try {
        const value = validateBankOfChinaSnapshot(await this.load(), this.now());
        if (this.closed) throw new Error('Rate cache stopped');
        const previous = this.db.prepare('SELECT payload FROM daily_bank_rates WHERE id=1').get();
        if (previous.payload) {
          const old = validateBankOfChinaSnapshot(JSON.parse(previous.payload), this.now());
          for (const [code, time] of Object.entries(value.quoteUpdateTimes)) {
            if (old.quoteUpdateTimes[code] > time) throw new Error('Bank quote timestamp went backwards');
          }
        }
        this.db.prepare(`UPDATE daily_bank_rates SET fetched_day=?, fetched_at=?, payload=? WHERE id=1 AND attempt_day=?`)
          .run(day, this.now(), JSON.stringify(value), day);
        this.logger?.info?.('clawbot-bookkeeping: daily Bank of China spot-selling quotes updated');
      } catch {
        this.logger?.warn?.('clawbot-bookkeeping: daily Bank of China update unavailable; retaining previous successful quotes');
      }
      if (this.closed) throw new Error('Rate cache stopped');
      return this.read();
    })();
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  start() {
    if (this.started || this.closed) return;
    this.started = true;
    const tick = () => {
      if (this.closed) return;
      void this.get().catch(() => {});
      this.timer = this.schedule(tick, millisecondsUntilSingaporeMidnight(this.now()));
      this.timer?.unref?.();
    };
    tick(); // Catch up once if the container missed midnight or has no cache.
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.db.close();
  }
}
