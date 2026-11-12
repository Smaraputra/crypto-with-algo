import { OrderBook } from './book';
import { DEFAULT_CONNECTION_CONFIG, ReconnectingConnection, type ClosedGap, type ConnectionConfig, type LostInfo } from './connection';
import type { Level, LogFn, QuoteState, TapeMarket, TapeSocketFactory, GapReport } from './types';

/**
 * Binance feed: one combined stream of `<symbol>@depth5@100ms` (the best five
 * levels per side as a full snapshot every 100 ms when the book changed) for
 * the markets that have a USDT-M symbol. bookTicker is not used: it runs at
 * about 500 frames a second per major symbol.
 *
 * Verified 2026-11-11: book streams are served under `/public`, not `/market`
 * (the market recorder's route for aggTrade and forceOrder).
 *
 * Frame (src/__fixtures__/tape/binance-public.jsonl):
 *   {"stream":"btcusdt@depth5@100ms","data":{"e":"depthUpdate","E":ms,"T":ms,"s":"BTCUSDT",
 *    "U":..,"u":..,"pu":..,"b":[["73863.90","0.445"],...],"a":[["73864.00","3.637"],...]}}
 * `exch` is the event time `E`.
 */

export const DEFAULT_BINANCE_WS_URL = 'wss://fstream.binance.com/public';
export const BINANCE_DEPTH_SUFFIX = '@depth5@100ms';

export type BinanceFrame =
  | { kind: 'depth'; symbol: string; exch: number; bids: Level[]; asks: Level[] }
  | { kind: 'ignored' }
  | { kind: 'invalid'; reason: string };

function levels(value: unknown): Level[] | null {
  if (!Array.isArray(value)) return null;
  const out: Level[] = [];
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length < 2) return null;
    const price = Number(raw[0]);
    const size = Number(raw[1]);
    if (!Number.isFinite(price) || !Number.isFinite(size)) return null;
    out.push([price, size]);
  }
  return out;
}

export function parseBinanceFrame(text: string): BinanceFrame {
  let msg: { stream?: unknown; data?: unknown };
  try {
    msg = JSON.parse(text) as typeof msg;
  } catch {
    return { kind: 'invalid', reason: 'not json' };
  }
  if (!msg || typeof msg !== 'object' || typeof msg.stream !== 'string') return { kind: 'ignored' };
  if (!msg.stream.endsWith(BINANCE_DEPTH_SUFFIX)) return { kind: 'ignored' };
  const data = msg.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') return { kind: 'invalid', reason: 'no data' };
  const bids = levels(data.b);
  const asks = levels(data.a);
  const exch = Number(data.E);
  const symbol = typeof data.s === 'string' ? data.s : '';
  if (!bids || !asks || !Number.isFinite(exch) || !symbol) return { kind: 'invalid', reason: 'depth fields' };
  return { kind: 'depth', symbol, exch, bids, asks };
}

export function buildBinanceUrl(base: string, symbols: readonly string[]): string {
  const streams = symbols.map((s) => `${s.toLowerCase()}${BINANCE_DEPTH_SUFFIX}`).join('/');
  return `${base.replace(/\/+$/, '')}/stream?streams=${streams}`;
}

interface SymbolState {
  coin: string;
  book: OrderBook;
  synced: boolean;
  exch: number | null;
  recv: number | null;
}

export interface BinanceFeedDeps {
  markets: TapeMarket[];
  baseUrl?: string;
  socketFactory: TapeSocketFactory;
  now: () => number;
  random?: () => number;
  log: LogFn;
  onGap(gap: GapReport): void;
  config?: Partial<ConnectionConfig> & { symbolStaleMs?: number };
}

/**
 * depth5 pushes only when the book changes, so a quiet symbol is normal for a
 * few seconds. A symbol with no frame for this long gets ok:false rows until a
 * frame arrives. (Lighter markets have no such rule: a Lighter stock perp off
 * hours can be quiet for hours and the connection ping keeps it alive.)
 */
export const DEFAULT_BINANCE_SYMBOL_STALE_MS = 60_000;

export class BinanceFeed {
  private readonly conn: ReconnectingConnection | null;
  private readonly bySymbol = new Map<string, SymbolState>();
  private readonly byCoin = new Map<string, SymbolState>();
  private invalidLogged = 0;
  counters = { frames: 0, depth: 0, invalid: 0 };

  private readonly symbolStaleMs: number;

  constructor(private readonly deps: BinanceFeedDeps) {
    this.symbolStaleMs = deps.config?.symbolStaleMs ?? DEFAULT_BINANCE_SYMBOL_STALE_MS;
    for (const m of deps.markets) {
      if (!m.binanceSymbol) continue;
      const state: SymbolState = { coin: m.coin, book: new OrderBook(), synced: false, exch: null, recv: null };
      this.bySymbol.set(m.binanceSymbol.toUpperCase(), state);
      this.byCoin.set(m.coin, state);
    }
    const symbols = [...this.bySymbol.keys()];
    this.conn =
      symbols.length === 0
        ? null
        : new ReconnectingConnection({
            name: 'binance',
            url: buildBinanceUrl(deps.baseUrl ?? DEFAULT_BINANCE_WS_URL, symbols),
            socketFactory: deps.socketFactory,
            now: deps.now,
            random: deps.random,
            log: deps.log,
            config: { ...DEFAULT_CONNECTION_CONFIG, ...deps.config },
            onOpen: () => undefined,
            onFrame: (data, recv) => this.onFrame(data, recv),
            onLost: (info) => this.onLost(info),
            onGapClosed: (gap) => this.onGapClosed(gap),
          });
  }

  get symbolCount(): number {
    return this.bySymbol.size;
  }

  /** False when no market has a Binance symbol: there is nothing to connect. */
  get enabled(): boolean {
    return this.conn !== null;
  }

  get connected(): boolean {
    return this.conn?.connected ?? false;
  }

  start(): void {
    this.conn?.start();
  }

  stop(): { reason: LostInfo['reason']; from: number } | null {
    return this.conn?.stop() ?? null;
  }

  hasCoin(coin: string): boolean {
    return this.byCoin.has(coin);
  }

  quote(coin: string): QuoteState | null {
    const s = this.byCoin.get(coin);
    if (!s) return null;
    if (!s.synced || s.recv === null || this.deps.now() - s.recv > this.symbolStaleMs) {
      return {
        ok: false,
        exch: s.exch,
        recv: s.recv,
        bid: null,
        ask: null,
        bidSz: null,
        askSz: null,
        rt100: null,
        rt1000: null,
        rt5000: null,
        rt20000: null,
      };
    }
    return { ok: true, exch: s.exch, recv: s.recv, ...s.book.summary() };
  }

  private onFrame(text: string, recv: number): void {
    this.counters.frames++;
    const frame = parseBinanceFrame(text);
    if (frame.kind === 'invalid') {
      this.counters.invalid++;
      if (this.invalidLogged++ < 5) this.deps.log('binance-invalid-frame', { reason: frame.reason, sample: text.slice(0, 200) });
      return;
    }
    if (frame.kind !== 'depth') return;
    const s = this.bySymbol.get(frame.symbol.toUpperCase());
    if (!s) return;
    s.book.applySnapshot(frame.asks, frame.bids);
    s.synced = true;
    s.exch = frame.exch;
    s.recv = recv;
    this.counters.depth++;
  }

  private onLost(info: LostInfo): void {
    void info;
    for (const s of this.bySymbol.values()) s.synced = false;
  }

  private onGapClosed(gap: ClosedGap): void {
    this.deps.onGap({ venue: 'binance', coin: null, reason: gap.reason, from: gap.from, to: gap.to });
  }
}
