import { RT_SIZES_USD, type BookSummary, type Level } from './types';

/**
 * Work counters, so a test can assert what a frame or a tick costs: `sorts`
 * counts full re-sorts (snapshots only), `walks` counts depth walks and
 * `summaries` counts summary computations (a cache hit adds nothing).
 */
export interface BookStats {
  sorts: number;
  walks: number;
  summaries: number;
}

/**
 * One side of a book as two parallel arrays kept sorted best-first (bids
 * descending, asks ascending). A Lighter delta touches a few dozen levels in
 * a book of up to 2,000, so a binary-searched splice beats re-sorting, and
 * the walk for a round-trip cost starts at index 0.
 */
class Side {
  readonly prices: number[] = [];
  readonly sizes: number[] = [];

  constructor(
    private readonly descending: boolean,
    private readonly stats: BookStats
  ) {}

  /** Index of the first price that is not better than `price`. */
  private find(price: number): number {
    let lo = 0;
    let hi = this.prices.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const before = this.descending ? this.prices[mid] > price : this.prices[mid] < price;
      if (before) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Size 0 (or less) removes the level. */
  set(price: number, size: number): void {
    const i = this.find(price);
    const exists = i < this.prices.length && this.prices[i] === price;
    if (size <= 0) {
      if (exists) {
        this.prices.splice(i, 1);
        this.sizes.splice(i, 1);
      }
    } else if (exists) {
      this.sizes[i] = size;
    } else {
      this.prices.splice(i, 0, price);
      this.sizes.splice(i, 0, size);
    }
  }

  replace(levels: readonly Level[]): void {
    this.stats.sorts++;
    const sorted = levels
      .filter(([p, s]) => Number.isFinite(p) && Number.isFinite(s) && p > 0 && s > 0)
      .sort((a, b) => (this.descending ? b[0] - a[0] : a[0] - b[0]));
    this.prices.length = 0;
    this.sizes.length = 0;
    let last = NaN;
    for (const [p, s] of sorted) {
      if (p === last) {
        this.sizes[this.sizes.length - 1] = s;
        continue;
      }
      this.prices.push(p);
      this.sizes.push(s);
      last = p;
    }
  }

  clear(): void {
    this.prices.length = 0;
    this.sizes.length = 0;
  }

  get length(): number {
    return this.prices.length;
  }

  /** Average fill price for `usd` of notional, or null when the visible side is too thin. */
  averagePrice(usd: number): number | null {
    this.stats.walks++;
    let remainingUsd = usd;
    let base = 0;
    for (let i = 0; i < this.prices.length; i++) {
      const levelUsd = this.prices[i] * this.sizes[i];
      const takeUsd = Math.min(remainingUsd, levelUsd);
      base += takeUsd / this.prices[i];
      remainingUsd -= takeUsd;
      if (remainingUsd <= 1e-9) return usd / base;
    }
    return null;
  }
}

/**
 * A limit order book built from a full snapshot plus level deltas (Lighter)
 * or from repeated 5-level snapshots (Binance depth5). Prices and sizes are
 * numbers; a level with size 0 is removed.
 */
export class OrderBook {
  readonly stats: BookStats = { sorts: 0, walks: 0, summaries: 0 };
  private readonly bids = new Side(true, this.stats);
  private readonly asks = new Side(false, this.stats);
  private version = 0;
  private cached: { version: number; summary: BookSummary } | null = null;

  /** Replaces the whole book. */
  applySnapshot(asks: readonly Level[], bids: readonly Level[]): void {
    this.asks.replace(asks);
    this.bids.replace(bids);
    this.version++;
  }

  /** Upserts each level; size 0 removes it. */
  applyDelta(asks: readonly Level[], bids: readonly Level[]): void {
    for (const [p, s] of asks) if (Number.isFinite(p) && Number.isFinite(s) && p > 0) this.asks.set(p, s);
    for (const [p, s] of bids) if (Number.isFinite(p) && Number.isFinite(s) && p > 0) this.bids.set(p, s);
    this.version++;
  }

  clear(): void {
    this.asks.clear();
    this.bids.clear();
    this.version++;
  }

  get bidCount(): number {
    return this.bids.length;
  }

  get askCount(): number {
    return this.asks.length;
  }

  bestBid(): Level | null {
    return this.bids.length ? [this.bids.prices[0], this.bids.sizes[0]] : null;
  }

  bestAsk(): Level | null {
    return this.asks.length ? [this.asks.prices[0], this.asks.sizes[0]] : null;
  }

  /** True when both sides exist and the best bid is at or above the best ask (a corrupt book). */
  isCrossed(): boolean {
    return this.bids.length > 0 && this.asks.length > 0 && this.bids.prices[0] >= this.asks.prices[0];
  }

  /**
   * Round-trip cost in basis points of mid for `usd` of notional: the average
   * price paid buying `usd` minus the average price received selling `usd`,
   * over mid. Null when the visible book is too thin on either side.
   */
  roundTripBps(usd: number): number | null {
    if (!(usd > 0) || !this.bids.length || !this.asks.length) return null;
    const mid = (this.bids.prices[0] + this.asks.prices[0]) / 2;
    const buy = this.asks.averagePrice(usd);
    const sell = this.bids.averagePrice(usd);
    if (buy === null || sell === null || !(mid > 0)) return null;
    return ((buy - sell) / mid) * 1e4;
  }

  /** Best quotes and the four round-trip costs (rounded to 0.0001 bp), cached until the book changes. */
  summary(): BookSummary {
    if (this.cached && this.cached.version === this.version) return this.cached.summary;
    this.stats.summaries++;
    const bid = this.bestBid();
    const ask = this.bestAsk();
    const [s100, s1000, s5000, s20000] = RT_SIZES_USD;
    const round4 = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);
    const summary: BookSummary = {
      bid: bid ? bid[0] : null,
      ask: ask ? ask[0] : null,
      bidSz: bid ? bid[1] : null,
      askSz: ask ? ask[1] : null,
      rt100: round4(this.roundTripBps(s100)),
      rt1000: round4(this.roundTripBps(s1000)),
      rt5000: round4(this.roundTripBps(s5000)),
      rt20000: round4(this.roundTripBps(s20000)),
    };
    this.cached = { version: this.version, summary };
    return summary;
  }
}

export const EMPTY_SUMMARY: BookSummary = Object.freeze({
  bid: null,
  ask: null,
  bidSz: null,
  askSz: null,
  rt100: null,
  rt1000: null,
  rt5000: null,
  rt20000: null,
});
