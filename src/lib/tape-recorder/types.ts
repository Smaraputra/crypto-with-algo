/**
 * Shared types for the tape recorder (scripts/ops/tape-recorder.ts): a
 * forward-only recorder of top-of-book and depth on Lighter and the matching
 * Binance USDT-M perps, plus Lighter trade prints, written as hourly gzip
 * JSON Lines. DATA INFRASTRUCTURE, NOT EXECUTION: nothing here trades.
 */
import type { SocketHandlers } from '@/lib/market-recorder/recorder';

export type { SocketHandlers };

/** One market in the markets file. `binanceSymbol` is null when Binance has no matching perp. */
export interface TapeMarket {
  coin: string;
  lighterMarketId: number;
  binanceSymbol: string | null;
}

export type Venue = 'lighter' | 'binance';

/** Round-trip cost sizes in USD, in the order of the `rt*` row fields. */
export const RT_SIZES_USD = [100, 1_000, 5_000, 20_000] as const;

/** A price level: [price, base size]. */
export type Level = [number, number];

/** The book summary a quote row is built from. All fields null when a side is empty. */
export interface BookSummary {
  bid: number | null;
  ask: number | null;
  bidSz: number | null;
  askSz: number | null;
  rt100: number | null;
  rt1000: number | null;
  rt5000: number | null;
  rt20000: number | null;
}

/** What a feed reports for one coin at sample time. */
export interface QuoteState extends BookSummary {
  /** False when the book is not synced: every price field is then null. */
  ok: boolean;
  /**
   * Latest exchange timestamp applied, ms. Lighter: the frame `timestamp`.
   * Binance: the depth frame event time `E`. Null before the first frame.
   */
  exch: number | null;
  /** Local receive time of the latest frame applied, ms. Null before the first frame. */
  recv: number | null;
}

/**
 * A 1 s or burst row. `t` is the sample boundary, never the time the row was
 * produced; `st` is the real sampling time (ms), so `st - t` is the lateness.
 *
 * READ RULE: use rows with `ok: true` only. A row is `ok: false` when the
 * book was not synced, when the market is unknown to the venue feed, or when
 * the row was sampled more than `LATE_ROW_MS` after its tick (`reason: 'late'`),
 * because its state could then include frames from after `t`. Every price
 * field of an `ok: false` row is null; `exch` and `recv` keep the last known
 * values so the age of the book can still be read.
 */
export interface QuoteRow extends QuoteState {
  t: number;
  st: number;
  coin: string;
  reason?: 'late';
}

/** A row sampled later than this after its tick is marked `ok: false`, `reason: 'late'`. */
export const LATE_ROW_MS = 50;

/** A burst row also carries the 5-minute boundary `g` it belongs to. */
export interface BurstRow extends QuoteRow {
  g: number;
}

/** A Lighter print. `t` is the exchange timestamp, `buy` is true when the taker bought. */
export interface TradeRow {
  t: number;
  recv: number;
  coin: string;
  px: number;
  sz: number;
  usd: number;
  buy: boolean;
  type: string;
}

export type StreamName = 'lighter-1s' | 'binance-1s' | 'lighter-burst' | 'binance-burst' | 'lighter-trades';

export const STREAM_NAMES: readonly StreamName[] = [
  'lighter-1s',
  'binance-1s',
  'lighter-burst',
  'binance-burst',
  'lighter-trades',
];

export type GapReason =
  | 'disconnect'
  | 'connect-failed'
  | 'stale'
  | 'resubscribe'
  | 'nonce-break'
  | 'crossed-book'
  | 'sampler-skip'
  | 'backpressure'
  | 'process-start'
  | 'write-error'
  | 'disk-floor'
  | 'stuck'
  | 'crashed-file'
  | 'late-row';

/**
 * A gap line in gaps.jsonl. `coin` is null for a connection-wide gap.
 *
 * `stream` and `file` (path relative to the tape folder) are present on the gap
 * lines that describe unpublished data of one hour file: `write-error`
 * (rows from the first row of the file to the close are in a `.failed-<ms>`
 * file, not published), `crashed-file` (a `.tmp` left by a crash was renamed
 * `.crashed-<ms>`) and `late-row` (rows refused for an hour file that had
 * already closed). Files ending in `.failed-<ms>` or `.crashed-<ms>` are NOT
 * part of the published data (they do not match `*.jsonl.gz`); they are
 * truncated gzip streams that may be salvaged by hand (for example
 * `gzip -dc file 2>/dev/null`, which prints everything up to the break).
 */
export interface GapRow {
  t: number;
  venue: Venue | 'tape';
  coin: string | null;
  reason: GapReason;
  from: number;
  to: number;
  stream?: StreamName;
  file?: string;
}

/** The slice of a gap a component reports. The recorder stamps `t`. */
export type GapReport = Omit<GapRow, 't'>;

export interface Heartbeat {
  t: number;
  markets: number;
  lighterConnected: boolean;
  binanceConnected: boolean;
  rowsLastMinute: number;
  lastGap: GapRow | null;
  droppedRows: number;
  /** True while rows are not being written because free space is below the floor. */
  diskFloor: boolean;
  /** Free space on the tape volume at the last check, GB. Null before the first check. */
  freeGb: number | null;
  /** True on the last write of a clean shutdown. */
  stopped: boolean;
}

/** A socket the tape feeds can write to. */
export interface TapeSocket {
  send(data: string): void;
  /** Detaches every handler, then closes. No handler fires afterwards. */
  close(): void;
}

export type TapeSocketFactory = (url: string, handlers: SocketHandlers) => TapeSocket;

export type LogFn = (event: string, fields: Record<string, unknown>) => void;
