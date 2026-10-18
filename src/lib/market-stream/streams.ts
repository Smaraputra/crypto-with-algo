/** Kline intervals Binance streams support. */
export const STREAM_INTERVALS = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
  '1M',
] as const;

/** At most this many streams per relay connection. */
export const MAX_STREAMS = 100;

export type StreamName = string;

const SYMBOL_PATTERN = /^[a-z0-9]{2,20}$/;
const VALID_INTERVALS = new Set<string>(STREAM_INTERVALS);

function isValidStreamName(stream: string): boolean {
  if (stream.endsWith('@ticker')) {
    const symbol = stream.slice(0, -'@ticker'.length);
    return SYMBOL_PATTERN.test(symbol);
  }

  const klinePrefix = '@kline_';
  const klineIndex = stream.indexOf(klinePrefix);
  if (klineIndex !== -1) {
    const symbol = stream.slice(0, klineIndex);
    const interval = stream.slice(klineIndex + klinePrefix.length);
    return SYMBOL_PATTERN.test(symbol) && VALID_INTERVALS.has(interval);
  }

  return false;
}

/** Lowercases the symbol and the stream type, but keeps the kline interval's case (`1M` is monthly, `1m` is one minute). */
function normalizeStream(raw: string): string {
  const at = raw.indexOf('@');
  if (at === -1) return raw.toLowerCase();
  const symbol = raw.slice(0, at).toLowerCase();
  const rest = raw.slice(at + 1);
  const klinePrefix = 'kline_';
  if (rest.toLowerCase().startsWith(klinePrefix)) {
    return `${symbol}@${klinePrefix}${rest.slice(klinePrefix.length)}`;
  }
  return `${symbol}@${rest.toLowerCase()}`;
}

/**
 * Validates the `streams` query value: names joined by '/', each `<symbol>@ticker` or `<symbol>@kline_<interval>`, symbol /^[a-z0-9]{2,20}$/.
 * The symbol and stream type are lowercased and the interval is matched case-sensitively.
 */
export function parseStreams(
  param: string | null
): { ok: true; streams: StreamName[] } | { ok: false; error: string } {
  if (param === null || param.trim() === '') {
    return { ok: false, error: 'streams is required' };
  }

  const rawParts = param.split('/').filter(Boolean);
  if (rawParts.length === 0) {
    return { ok: false, error: 'streams is required' };
  }

  const streams: StreamName[] = [];
  const seen = new Set<string>();

  for (const raw of rawParts) {
    const normalized = normalizeStream(raw);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      streams.push(normalized);
    }
  }

  if (streams.length > MAX_STREAMS) {
    return { ok: false, error: 'at most 100 streams' };
  }

  for (const stream of streams) {
    if (!isValidStreamName(stream)) {
      return { ok: false, error: `invalid stream: ${stream}` };
    }
  }

  return { ok: true, streams };
}

/** `btcusdt@ticker` from any symbol case. */
export function tickerStream(symbol: string): StreamName {
  return `${symbol.toLowerCase()}@ticker`;
}

/** `btcusdt@kline_1M`: the symbol is lowercased, the interval keeps its case (`1M` monthly vs `1m`). */
export function klineStream(symbol: string, interval: string): StreamName {
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

/** `${base}/stream?streams=${streams.join('/')}` with a trailing slash on base removed. */
export function upstreamUrl(base: string, streams: readonly StreamName[]): string {
  const cleanBase = base.replace(/\/+$/, '');
  return `${cleanBase}/stream?streams=${streams.join('/')}`;
}

/** One SSE frame: `data: <json>\n\n`. */
export function sseData(json: string): string {
  return `data: ${json}\n\n`;
}

/** The heartbeat comment frame: `: ping\n\n`. */
export const SSE_PING = ': ping\n\n';
