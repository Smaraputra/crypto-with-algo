import type { OHLCV } from '@/types/market';
import type { HtfInput } from './optimized-engine';
import {
  buildSnapshotSeries,
  LS_Z_WARMUP_MS,
  mapToSnapshotInterval,
  type SnapshotBar,
} from './snapshot-series';
import { getConfirmationInterval } from '@/lib/signals/htf';
import { intervalToMs } from '@/lib/intervals';
import { DATA_RANGE_OPTIONS, INTERVAL_MS, type DataRange } from './options';

export type LoadBacktestInputsResult =
  | { ok: true; klines: OHLCV[]; snapshots?: (SnapshotBar | null)[]; htfInput?: HtfInput; notices: string[] }
  | { ok: false; reason: 'fetch_failed' | 'insufficient'; bars: number; message: string };

export async function loadBacktestInputs(args: {
  symbol: string;
  interval: string; // already mapped, e.g. '1h'
  dataRange: DataRange;
  now?: number; // default Date.now(), injectable for tests
  fetchImpl?: typeof fetch; // default global fetch, injectable for tests
}): Promise<LoadBacktestInputsResult> {
  const { symbol, interval, dataRange, now, fetchImpl } = args;
  const currentTime = now ?? Date.now();
  const fetchFn = fetchImpl ?? fetch;
  const rangeOption = DATA_RANGE_OPTIONS.find((r) => r.value === dataRange);

  let klines: OHLCV[];

  try {
    let res: Response;
    if (dataRange === 'legacy' || !rangeOption) {
      // Legacy: fetch 500 candles from stored data
      const barMs = INTERVAL_MS[interval] ?? 3600000;
      const startTime = currentTime - 500 * barMs;
      res = await fetchFn(
        `/api/candles?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=500`
      );
    } else {
      // Deep history: fetch from MongoDB via /api/candles
      const startTime = currentTime - rangeOption.months * 30 * 24 * 60 * 60 * 1000;
      res = await fetchFn(
        `/api/candles?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=50000`
      );
    }

    if (!res.ok) {
      return {
        ok: false,
        reason: 'fetch_failed',
        bars: 0,
        message: 'Failed to fetch candle data.',
      };
    }

    const data = await res.json();
    klines = data?.candles;
  } catch {
    return {
      ok: false,
      reason: 'fetch_failed',
      bars: 0,
      message: 'Failed to fetch candle data.',
    };
  }

  if (!klines || klines.length < 200) {
    return {
      ok: false,
      reason: 'insufficient',
      bars: klines?.length ?? 0,
      message: `Insufficient candle data (${klines?.length ?? 0} bars). Try downloading history first.`,
    };
  }

  // Best-effort point-in-time futures/sentiment; bars without data stay
  // null and the scorer redistributes weights, so failure never blocks
  let snapshots: (SnapshotBar | null)[] | undefined;
  try {
    const snapshotInterval = mapToSnapshotInterval(interval);
    const maxRangeMs = 364 * 24 * 60 * 60 * 1000; // API caps at 1 year
    // Thirty days early, so the L/S z (configVersion 8) is defined from the
    // first bar; a 4h/1d run also needs the 1h rows the z is computed on.
    const snapStart = Math.max(klines[0].timestamp - LS_Z_WARMUP_MS, currentTime - maxRangeMs);
    const snapshotUrl = (iv: string) =>
      `/api/historical-snapshots?symbol=${symbol}&interval=${iv}&startTime=${snapStart}&endTime=${currentTime}`;
    const [snapRes, lsRes] = await Promise.all([
      fetchFn(snapshotUrl(snapshotInterval)),
      snapshotInterval === '1h' ? Promise.resolve(null) : fetchFn(snapshotUrl('1h')),
    ]);
    if (snapRes.ok) {
      const snapData = await snapRes.json();
      // A failed 1h read leaves the z undefined, so the L/S signal abstains
      // openly instead of the series refusing to build.
      const lsRows1h = lsRes ? (lsRes.ok ? ((await lsRes.json()).snapshots ?? []) : []) : undefined;
      if (snapData.snapshots?.length) {
        snapshots = buildSnapshotSeries(klines, snapData.snapshots, interval, { symbol, lsRows1h });
      }
    }
  } catch {
    // Run without snapshot data
  }

  // Best-effort higher-timeframe candles for MTF confluence; the extra
  // 250-bar margin covers HTF indicator warmup before the LTF range starts
  let htfInput: HtfInput | undefined;
  const notices: string[] = [];
  const htfInterval = getConfirmationInterval(interval);
  if (htfInterval) {
    try {
      const htfMs = intervalToMs(htfInterval);
      const htfStart = klines[0].timestamp - 250 * htfMs;
      const htfRes = await fetchFn(
        `/api/candles?symbol=${symbol}&interval=${htfInterval}&startTime=${htfStart}&limit=50000`
      );
      if (htfRes.ok) {
        const htfData = await htfRes.json();
        if (htfData.candles?.length) {
          htfInput = { candles: htfData.candles, interval: htfInterval };
        }
      }
    } catch {
      // Run without higher-timeframe context
    }
    if (!htfInput) {
      notices.push('Higher-timeframe data unavailable; running without MTF confluence.');
    }
  }

  return {
    ok: true,
    klines,
    snapshots,
    htfInput,
    notices,
  };
}
