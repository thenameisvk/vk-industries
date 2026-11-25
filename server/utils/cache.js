'use strict';

/* =====================================================================
   In-memory cache with TTL, remember(), clear(), and namespace support.
   - Drop-in replacement for anything calling cache.get/set/remember/clear
   - Safe under crashes: never throws, always resolves
   - Auto-cleans expired keys every 60s (no memory leak)
   ===================================================================== */

class MemoryCache {
  constructor({ defaultTTL = 60_000, maxKeys = 500 } = {}) {
    this.store = new Map();          // key → { value, expiresAt }
    this.defaultTTL = defaultTTL;
    this.maxKeys = maxKeys;
    this.hits = 0;
    this.misses = 0;

    // periodic cleanup
    this._sweeper = setInterval(() => this._sweep(), 60_000);
    if (this._sweeper.unref) this._sweeper.unref(); // don't block process exit
  }

  /* ---------- low-level ---------- */
  get(key) {
    const row = this.store.get(key);
    if (!row) { this.misses++; return undefined; }
    if (row.expiresAt && row.expiresAt < Date.now()) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return row.value;
  }

  set(key, value, ttlMs = this.defaultTTL) {
    if (this.store.size >= this.maxKeys) {
      // evict oldest key (Map preserves insertion order)
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, {
      value,
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0,
    });
    return value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  del(key) {
    return this.store.delete(key);
  }

  /** Alias used across the codebase — never throws, always resolves */
  clear(prefix) {
    if (!prefix) {
      this.store.clear();
      return true;
    }
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
    return true;
  }

  /** Remember pattern: return the cached value, or compute it once and cache it.
   *  Accepts BOTH call styles so an old caller can never get `undefined` back:
   *     remember(key, producer)              → default TTL
   *     remember(key, ttlMs, producer)       → explicit TTL
   *  Requests that arrive while the value is being computed share ONE computation. */
  async remember(key, ttlOrProducer, maybeProducer) {
    let ttlMs = this.defaultTTL;
    let producer = maybeProducer;
    if (typeof ttlOrProducer === 'number') ttlMs = ttlOrProducer;
    else if (maybeProducer === undefined) producer = ttlOrProducer;   // remember(key, producer|value)

    const cached = this.get(key);
    if (cached !== undefined) return cached;

    if (!this._pending) this._pending = new Map();
    if (this._pending.has(key)) return this._pending.get(key);

    const job = (async () => {
      const value = typeof producer === 'function' ? await producer() : producer;
      // never cache undefined/null (a failed or empty result must not stick)
      if (value !== undefined && value !== null) this.set(key, value, ttlMs);
      return value;
    })();
    this._pending.set(key, job);
    try {
      return await job;
    } finally {
      this._pending.delete(key);
    }
  }

  /* ---------- housekeeping ---------- */
  _sweep() {
    const now = Date.now();
    for (const [k, row] of this.store) {
      if (row.expiresAt && row.expiresAt < now) this.store.delete(k);
    }
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? +(this.hits / total).toFixed(3) : 0,
    };
  }

  /** Manually stop the sweeper (used in tests / shutdown) */
  dispose() {
    clearInterval(this._sweeper);
    this.store.clear();
  }
}

/* Singleton — import this everywhere */
const cache = new MemoryCache({ defaultTTL: 60_000, maxKeys: 500 });

module.exports = cache;
module.exports.MemoryCache = MemoryCache;
