import { LATE_ROW_MS, type BurstRow, type GapReport, type QuoteRow, type QuoteState, type StreamName, type Venue } from './types';

/**
 * Wall-clock sampler. It owns no timer: the caller calls `advance(now)` as
 * often as it likes (the recorder does it every 100 ms) and the sampler emits
 * a row for every grid tick up to `now`, in order.
 *
 *   1 s rows     every whole second, one row per coin per venue
 *   burst rows   every 100 ms from 1 s before to 3 s after every 5-minute UTC
 *                boundary (both ends included), the boundary `g` in the row
 *
 * LATENESS. A row's `t` is always the grid tick, never the time it was
 * produced, and `st` is the real sampling time. A late call emits the missed
 * ticks, so a stalled process never skips a second silently, but a row
 * sampled more than `LATE_ROW_MS` after its tick could carry state from after
 * `t`, so it is written `ok: false`, `reason: 'late'`, prices null (read rule
 * in types.ts: use rows with ok true). If the sampler is more than
 * `maxCatchUpMs` behind, the oldest ticks are dropped and the span is
 * reported through `onGap`.
 *
 * WAKE-UPS. Between rows there is nothing to do, so `nextDue` names the next
 * tick that emits (a whole second or a burst tick) and the caller sleeps until
 * then: 1 wake-up a second outside the burst windows instead of 10.
 */

export const TICK_MS = 100;
export const SECOND_MS = 1_000;
export const BOUNDARY_MS = 5 * 60 * SECOND_MS;
export const BURST_BEFORE_MS = 1_000;
export const BURST_AFTER_MS = 3_000;

export interface SamplerSource {
  quote(venue: Venue, coin: string): QuoteState | null;
}

export interface SamplerConfig {
  maxCatchUpMs: number;
}

export const DEFAULT_SAMPLER_CONFIG: SamplerConfig = { maxCatchUpMs: 5_000 };

export interface SamplerDeps {
  coins: Record<Venue, readonly string[]>;
  source: SamplerSource;
  emit(stream: StreamName, row: QuoteRow | BurstRow): void;
  onGap(gap: GapReport): void;
  config?: Partial<SamplerConfig>;
}

/** The 5-minute boundary whose burst window contains `t`, or null. */
export function burstBoundary(t: number): number | null {
  const g = Math.round(t / BOUNDARY_MS) * BOUNDARY_MS;
  const offset = t - g;
  return offset >= -BURST_BEFORE_MS && offset <= BURST_AFTER_MS ? g : null;
}

export class Sampler {
  private readonly cfg: SamplerConfig;
  /** The next tick to emit. Null until `start`. */
  private cursor: number | null = null;

  constructor(private readonly deps: SamplerDeps) {
    this.cfg = { ...DEFAULT_SAMPLER_CONFIG, ...deps.config };
  }

  /** The first tick strictly after `now` becomes the first emitted row. */
  start(now: number): void {
    this.cursor = (Math.floor(now / TICK_MS) + 1) * TICK_MS;
  }

  /** The next tick not yet emitted, for scheduling. */
  get nextTick(): number {
    if (this.cursor === null) throw new Error('Sampler.start was not called');
    return this.cursor;
  }

  /** The next tick that emits at least one row. Never more than 1 s away. */
  get nextDue(): number {
    let t = this.nextTick;
    for (let i = 0; i < SECOND_MS / TICK_MS; i++, t += TICK_MS) {
      if (t % SECOND_MS === 0 || burstBoundary(t) !== null) return t;
    }
    return t;
  }

  /** Emits every tick with `t <= now` that has not been emitted. Returns the number of rows emitted. */
  advance(now: number): number {
    if (this.cursor === null) throw new Error('Sampler.start was not called');
    const last = Math.floor(now / TICK_MS) * TICK_MS;
    if (last < this.cursor) return 0;

    const earliest = last - Math.floor(this.cfg.maxCatchUpMs / TICK_MS) * TICK_MS;
    if (this.cursor < earliest) {
      this.deps.onGap({ venue: 'tape', coin: null, reason: 'sampler-skip', from: this.cursor, to: earliest - TICK_MS });
      this.cursor = earliest;
    }

    let rows = 0;
    for (let t = this.cursor; t <= last; t += TICK_MS) {
      if (t % SECOND_MS === 0) rows += this.sample(t, null, now);
      const g = burstBoundary(t);
      if (g !== null) rows += this.sample(t, g, now);
    }
    this.cursor = last + TICK_MS;
    return rows;
  }

  private sample(t: number, g: number | null, st: number): number {
    const late = st - t > LATE_ROW_MS;
    let rows = 0;
    for (const venue of ['lighter', 'binance'] as const) {
      const stream: StreamName =
        g === null ? (venue === 'lighter' ? 'lighter-1s' : 'binance-1s') : venue === 'lighter' ? 'lighter-burst' : 'binance-burst';
      for (const coin of this.deps.coins[venue]) {
        const q = late ? NOT_QUOTED : (this.deps.source.quote(venue, coin) ?? NOT_QUOTED);
        const known = late ? this.deps.source.quote(venue, coin) : q;
        const row: QuoteRow = {
          t,
          st,
          coin,
          exch: known?.exch ?? null,
          recv: known?.recv ?? null,
          bid: q.bid,
          ask: q.ask,
          bidSz: q.bidSz,
          askSz: q.askSz,
          rt100: q.rt100,
          rt1000: q.rt1000,
          rt5000: q.rt5000,
          rt20000: q.rt20000,
          ok: q.ok,
        };
        if (late) row.reason = 'late';
        this.deps.emit(stream, g === null ? row : { ...row, g });
        rows++;
      }
    }
    return rows;
  }
}

const NOT_QUOTED: QuoteState = {
  ok: false,
  exch: null,
  recv: null,
  bid: null,
  ask: null,
  bidSz: null,
  askSz: null,
  rt100: null,
  rt1000: null,
  rt5000: null,
  rt20000: null,
};
