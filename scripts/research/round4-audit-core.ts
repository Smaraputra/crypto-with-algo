import type { ArchiveFileSpec } from '@/lib/external/binance-archive';
import {
  L3_BARS,
  L4_LAG_MS,
  L4_PERIOD_MS,
  L4_POINTS,
  LAB_HYPOTHESES_V1,
  LAB_HYPOTHESES_V2,
  LAB_HYPOTHESES_V3,
  LAB_HYPOTHESES_V4,
  LAB_V3_UNIVERSE,
} from '@/lib/signals/lab/candidates';
import { l1Scores, l2Scores, l3Scores, l4Scores, type RatioPoint } from '@/lib/signals/lab/factors';
import { n2BookAt, n2HistoryNeeded, type Bar1d } from '@/lib/signals/lab/v2/n2';
import { dailyValueAreas, n3BarsNeeded, n3Position, type Bar15 } from '@/lib/signals/lab/v2/n3';
import { DAY_MS, staggeredBook, targetBook } from '@/lib/signals/lab/v3/f1';
import {
  HOUR_MS,
  LAB_V4_WINDOW_BARS,
  isContiguousHourly,
  s1SideAtLast,
  s2SideAtLast,
} from '@/lib/signals/lab/v4/rules';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import type { OHLCV } from '@/types/market';
import { createHash } from 'node:crypto';

export class AuditValidationError extends Error {}

export function externalFailureTag(error: unknown): string {
  const value =
    error !== null && typeof error === 'object'
      ? (error as { name?: unknown; code?: unknown })
      : {};
  const names = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'AbortError',
    'MongoServerError',
    'MongoNetworkError',
    'MongoServerSelectionError',
    'MongoParseError',
    'ArchiveIntegrityError',
  ]);
  const name = typeof value.name === 'string' && names.has(value.name) ? value.name : 'Error';
  return typeof value.code === 'number' && Number.isSafeInteger(value.code)
    ? `${name} (code ${value.code})`
    : name;
}

export interface ReplayRow {
  _id: unknown;
  candidate: string;
  version: string;
  hypothesis: string;
  timeframe: string;
  barClose: number;
  writtenAt?: Date;
  late?: boolean;
  scores: Record<string, number>;
  skipped: { symbol: string; reason: string }[];
  inputs: unknown;
}
type ScoreResult = {
  scores: Record<string, number>;
  skipped: { symbol: string; reason: string }[];
};
export interface ReplayAdapters {
  rv: (
    barTime: number
  ) => Promise<{ ranked: { symbol: string; compositeZ: number; rank: number }[] } | null>;
  bars: (
    venue: 'spot' | 'perp',
    symbol: string,
    interval: string,
    from: number,
    to: number
  ) => Promise<OHLCV[]>;
  ratios: (symbol: string, from: number, to: number) => Promise<RatioPoint[]>;
  prior: (row: ReplayRow, from: number, to: number) => Promise<ReplayRow[]>;
}
export type ReplayStatus = 'matched' | 'mismatched' | 'unreproducible';
export interface RowReport {
  id: string;
  candidate: string;
  hypothesis: string;
  barClose: number;
  status: ReplayStatus;
  provenance: 'exact' | 'reconstructed' | 'unavailable';
  reason?: string;
  scope?: string;
  differences?: string[];
  recomputed?: ScoreResult;
  bookReplay?: {
    status: 'matched' | 'mismatched';
    differences: string[];
    scores: Record<string, number>;
    target: Record<string, number>;
  };
}
function object(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function finiteRecord(v: unknown): v is Record<string, number> {
  return (
    object(v) !== null &&
    Object.values(v as Record<string, unknown>).every(
      (n) => typeof n === 'number' && Number.isFinite(n)
    )
  );
}
export function approximately(a: number, b: number): boolean {
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a - b) <= 1e-12 + 1e-10 * Math.max(Math.abs(a), Math.abs(b))
  );
}
function scoreDifferences(
  actual: Record<string, number>,
  expected: Record<string, number>,
  prefix = 'scores'
): string[] {
  return [...new Set([...Object.keys(actual), ...Object.keys(expected)])]
    .sort()
    .filter((k) => !(k in actual) || !(k in expected) || actual[k] !== expected[k])
    .map((k) => `${prefix}.${k}`);
}
function differences(row: ReplayRow, computed: ScoreResult): string[] {
  const result = scoreDifferences(row.scores, computed.scores);
  const keys = (s: ScoreResult['skipped']) =>
    [...new Set(s.map((v) => `${v.symbol}:${v.reason}`))].sort();
  if (JSON.stringify(keys(row.skipped)) !== JSON.stringify(keys(computed.skipped)))
    result.push('skipped');
  return result;
}
function inputsHash<T extends { t: number }>(bySymbol: Record<string, T[]>): string {
  const flat = Object.keys(bySymbol)
    .sort()
    .flatMap((symbol) =>
      [...bySymbol[symbol]].sort((a, b) => a.t - b.t).map((b) => ({ symbol, ...b }))
    );
  return createHash('sha256').update(JSON.stringify(flat)).digest('hex');
}
function validBars(
  bars: OHLCV[],
  from: number,
  to: number,
  interval: number,
  requireTaker = false
): boolean {
  return (
    bars.length === (to - from) / interval &&
    bars.every(
      (b, i) =>
        b.timestamp === from + i * interval &&
        [b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) &&
        b.close > 0 &&
        (!requireTaker || Number.isFinite(b.takerBuyVolume))
    )
  );
}

export async function replayRow(row: ReplayRow, deps: ReplayAdapters): Promise<RowReport> {
  const base = {
    id: String(row._id),
    candidate: row.candidate,
    hypothesis: row.hypothesis,
    barClose: row.barClose,
  };
  const unavailable = (reason: string): RowReport => ({
    ...base,
    status: 'unreproducible',
    provenance: 'unavailable',
    reason,
  });
  const hypotheses = [
    ...LAB_HYPOTHESES_V1,
    ...LAB_HYPOTHESES_V2,
    ...LAB_HYPOTHESES_V3,
    ...LAB_HYPOTHESES_V4,
  ];
  if (
    !hypotheses.some(
      (h) =>
        h.candidate === row.candidate &&
        h.id === row.hypothesis &&
        h.version === row.version &&
        h.timeframe === row.timeframe
    )
  )
    return unavailable('unsupported candidate/version/hypothesis');
  if (!Number.isSafeInteger(row.barClose) || !finiteRecord(row.scores))
    return unavailable('invalid stored scores');
  if (
    !Array.isArray(row.skipped) ||
    !row.skipped.every((s) => s && typeof s.symbol === 'string' && typeof s.reason === 'string')
  )
    return unavailable('invalid stored skipped set');
  const inputs = object(row.inputs);
  if (!inputs) return unavailable('missing inputs');
  let provenance: RowReport['provenance'] = 'exact';
  let computed: ScoreResult;
  const T = row.barClose;
  try {
    if (row.candidate === 'L1' || row.candidate === 'L2') {
      if (!('rvBarTime' in inputs)) return unavailable('missing inputs.rvBarTime');
      if (
        inputs.rvBarTime !== null &&
        (typeof inputs.rvBarTime !== 'number' || !Number.isFinite(inputs.rvBarTime))
      )
        return unavailable('invalid inputs.rvBarTime');
      if (row.candidate === 'L1' && inputs.rvBarTime === null)
        return unavailable('missing inputs.rvBarTime');
      const rv =
        inputs.rvBarTime === null ? { ranked: [] } : await deps.rv(inputs.rvBarTime as number);
      if (!rv) return unavailable('pinned rvsignals record missing');
      if (
        !Array.isArray(rv.ranked) ||
        !rv.ranked.every(
          (r) =>
            typeof r.symbol === 'string' && Number.isFinite(r.rank) && Number.isFinite(r.compositeZ)
        )
      )
        return unavailable('invalid pinned rvsignals ranks');
      if (row.candidate === 'L1') computed = l1Scores(SIGNAL_SYMBOLS, rv.ranked);
      else {
        const v8 = object(inputs.v8);
        if (!v8) return unavailable('missing inputs.v8');
        const v8Scores: Record<string, number> = {};
        for (const [symbol, v] of Object.entries(v8)) {
          const value = object(v)?.score;
          if (typeof value !== 'number' || !Number.isFinite(value))
            return unavailable(`invalid inputs.v8.${symbol}.score`);
          v8Scores[symbol] = value;
        }
        computed = l2Scores(SIGNAL_SYMBOLS, v8Scores, rv.ranked);
      }
    } else if (row.candidate === 'L3' || row.candidate === 'S1' || row.candidate === 'S2') {
      if (
        Object.keys(object(inputs.errors) ?? {}).length ||
        row.skipped.some((s) => s.reason.startsWith('bars_') || s.reason === 'forming_bar')
      )
        return unavailable('historical REST failure response unavailable');
      if (row.candidate === 'L3' && !object(inputs.lastBarOpenTime))
        return unavailable('missing inputs.lastBarOpenTime');
      if (
        row.candidate === 'L3' &&
        SIGNAL_SYMBOLS.some((symbol) => object(inputs.lastBarOpenTime)?.[symbol] !== T - HOUR_MS)
      )
        return unavailable('original L3 bar window incomplete or metadata missing');
      if (
        row.candidate !== 'L3' &&
        (inputs.windowBars !== LAB_V4_WINDOW_BARS || inputs.lastBarOpen !== T - HOUR_MS)
      )
        return unavailable('missing or invalid v4 window metadata');
      const count = row.candidate === 'L3' ? L3_BARS : LAB_V4_WINDOW_BARS;
      const bySymbol: Record<string, OHLCV[]> = {};
      for (const symbol of SIGNAL_SYMBOLS) {
        const bars = await deps.bars('perp', symbol, '1h', T - count * HOUR_MS, T);
        if (!validBars(bars, T - count * HOUR_MS, T, HOUR_MS, row.candidate !== 'L3'))
          return unavailable(`stored 1h perpetual inputs incomplete or invalid: ${symbol}`);
        bySymbol[symbol] = bars;
      }
      provenance = 'reconstructed';
      if (row.candidate === 'L3') {
        computed = l3Scores(
          SIGNAL_SYMBOLS,
          Object.fromEntries(
            Object.entries(bySymbol).map(([symbol, bars]) => [
              symbol,
              bars.map((b) => ({
                openTime: b.timestamp,
                closeTime: b.timestamp + HOUR_MS - 1,
                close: b.close,
              })),
            ])
          ),
          T
        );
      } else {
        const prior = await deps.prior(row, T - 8 * HOUR_MS, T);
        // The frozen job blocks on every prior row, including rows written late.
        const blocked = new Set(
          prior
            .filter((p) => p.barClose > T - 8 * HOUR_MS && p.barClose < T)
            .flatMap((p) =>
              Object.entries(p.scores)
                .filter(([, v]) => typeof v === 'number' && v !== 0)
                .map(([s]) => s)
            )
        );
        computed = { scores: {}, skipped: [] };
        for (const symbol of SIGNAL_SYMBOLS) {
          const bars = bySymbol[symbol];
          if (!isContiguousHourly(bars, T - HOUR_MS))
            return unavailable(`stored 1h perpetual bars not contiguous: ${symbol}`);
          const side = row.candidate === 'S1' ? s1SideAtLast(bars) : s2SideAtLast(bars);
          if (side !== 0) {
            if (blocked.has(symbol)) computed.skipped.push({ symbol, reason: 'in_trade' });
            else computed.scores[symbol] = side;
          }
        }
      }
    } else if (row.candidate === 'L4') {
      if (!object(inputs.points) || !object(inputs.windowSizes) || !object(inputs.errors))
        return unavailable('missing immutable ratio window metadata');
      if (row.skipped.some((s) => s.reason.startsWith('ratio_')))
        return unavailable('original incomplete ratio response unavailable');
      const cutoff = T - L4_LAG_MS;
      const points: Record<string, RatioPoint[]> = {};
      for (const symbol of SIGNAL_SYMBOLS) {
        points[symbol] = await deps.ratios(symbol, cutoff - (L4_POINTS + 1) * L4_PERIOD_MS, cutoff);
        if (
          points[symbol].length < L4_POINTS ||
          new Set(points[symbol].map((p) => p.timestamp)).size !== points[symbol].length
        )
          return unavailable(`immutable ratio history incomplete or duplicated: ${symbol}`);
      }
      provenance = 'reconstructed';
      computed = l4Scores(SIGNAL_SYMBOLS, points, T).result;
      if (computed.skipped.length)
        return unavailable('immutable ratio history cannot recover original input window');
    } else if (row.candidate === 'N2' || row.candidate === 'N3') {
      if (typeof inputs.inputsSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(inputs.inputsSha256))
        return unavailable('missing or invalid inputs.inputsSha256');
      const isN2 = row.candidate === 'N2';
      const { startTime, endTime } = isN2 ? n2HistoryNeeded(T) : n3BarsNeeded(T);
      const daily: Record<string, Bar1d[]> = {};
      const intraday: Record<string, Bar15[]> = {};
      for (const symbol of SIGNAL_SYMBOLS) {
        const bars = (
          await deps.bars('spot', symbol, isN2 ? '1d' : '15m', startTime, endTime + 1)
        ).filter((b) => b.timestamp < T);
        if (isN2)
          daily[symbol] = bars.map((b) => ({
            t: b.timestamp,
            o: b.open,
            h: b.high,
            l: b.low,
            c: b.close,
            v: b.volume,
            ...(b.takerBuyVolume !== undefined && Number.isFinite(b.takerBuyVolume)
              ? { tbv: b.takerBuyVolume }
              : {}),
          }));
        else
          intraday[symbol] = bars.map((b) => ({
            t: b.timestamp,
            o: b.open,
            h: b.high,
            l: b.low,
            c: b.close,
            v: b.volume,
          }));
      }
      // Hash validation must precede the costly frozen ridge fit.
      if ((isN2 ? inputsHash(daily) : inputsHash(intraday)) !== inputs.inputsSha256)
        return unavailable('inputsSha256 mismatch');
      if (isN2) computed = { scores: n2BookAt(daily, T).weights, skipped: [] };
      else {
        computed = { scores: {}, skipped: [] };
        for (const symbol of SIGNAL_SYMBOLS) {
          const vas = dailyValueAreas(intraday[symbol]);
          if (![1, 2, 3].every((k) => vas.has(T - k * DAY_MS)))
            computed.skipped.push({ symbol, reason: 'va_incomplete' });
          else {
            const position = n3Position(vas, T);
            if (position !== 0) computed.scores[symbol] = position;
          }
        }
      }
    } else {
      if (!finiteRecord(inputs.rawScores))
        return unavailable('missing or invalid inputs.rawScores');
      if (!finiteRecord(inputs.targetBook))
        return unavailable('missing or invalid inputs.targetBook');
      const currentTarget = targetBook(
        Object.entries(inputs.rawScores).map(([symbol, score]) => ({ symbol, score }))
      );
      const prior = await deps.prior(row, T - 7 * DAY_MS, T);
      const pastTargets = [currentTarget];
      for (let k = 1; k < 7; k++) {
        const matches = prior.filter((p) => p.barClose === T - k * DAY_MS);
        if (matches.length > 1) return unavailable('duplicate prior F1 target rows');
        const target = matches.length ? object(matches[0].inputs)?.targetBook : {};
        if (!finiteRecord(target))
          return unavailable(`missing or invalid prior F1 target at ${T - k * DAY_MS}`);
        pastTargets.push(new Map(Object.entries(target)));
      }
      const scores = Object.fromEntries(staggeredBook(pastTargets));
      const diff = [
        ...scoreDifferences(row.scores, scores),
        ...scoreDifferences(inputs.targetBook, Object.fromEntries(currentTarget), 'targetBook'),
      ];
      const missing = LAB_V3_UNIVERSE.filter(
        (s) => !(s in (inputs.rawScores as Record<string, number>))
      );
      return {
        ...unavailable(
          missing.length
            ? 'funding/delisting history unavailable for skipped or missing raw-score symbols'
            : 'raw funding settlements not preserved by score-to-book replay'
        ),
        scope:
          'stored raw funding scores -> target -> stagger; raw funding settlements not rederived',
        bookReplay: {
          status: diff.length ? 'mismatched' : 'matched',
          differences: diff,
          scores,
          target: Object.fromEntries(currentTarget),
        },
      };
    }
    const diff = differences(row, computed);
    return {
      ...base,
      status: diff.length ? 'mismatched' : 'matched',
      provenance,
      differences: diff,
      recomputed: computed,
    };
  } catch (error) {
    return unavailable(
      `historical input read or replay failed: ${error instanceof AuditValidationError ? error.message : externalFailureTag(error)}`
    );
  }
}

type Counts = { total: number; matched: number; mismatched: number; unreproducible: number };
const emptyCounts = (): Counts => ({ total: 0, matched: 0, mismatched: 0, unreproducible: 0 });
export async function auditReplay(
  rows: AsyncIterable<ReplayRow>,
  deps: ReplayAdapters,
  write: (r: RowReport) => Promise<void>,
  exampleCap = 20
) {
  const report = {
    ...emptyCounts(),
    candidates: Object.create(null) as Record<string, Counts>,
    provenance: { exact: 0, reconstructed: 0, unavailable: 0 },
    bookReplay: { matched: 0, mismatched: 0 },
    examples: [] as RowReport[],
  };
  for await (const row of rows) {
    const result = await replayRow(row, deps);
    report.total++;
    report[result.status]++;
    report.provenance[result.provenance]++;
    const counts = (report.candidates[row.candidate] ??= emptyCounts());
    counts.total++;
    counts[result.status]++;
    if (result.bookReplay) report.bookReplay[result.bookReplay.status]++;
    if (result.status !== 'matched' && report.examples.length < exampleCap)
      report.examples.push(result);
    await write(result);
  }
  if (report.total !== report.matched + report.mismatched + report.unreproducible)
    throw new AuditValidationError('replay accounting invariant failed');
  return report;
}

export const D_FROM = Date.UTC(2022, 0, 1);
export const D_TO = Date.UTC(2026, 6, 1);
export interface CandleBar extends OHLCV {
  quoteVolume?: number;
  trades?: number;
}
const CANDLE_FIELDS = ['open', 'high', 'low', 'close', 'volume'] as const;
function validCandle(b: CandleBar): boolean {
  return (
    CANDLE_FIELDS.every((k) => Number.isFinite(b[k])) &&
    b.volume >= 0 &&
    b.low > 0 &&
    b.high >= Math.max(b.open, b.close) &&
    b.low <= Math.min(b.open, b.close) &&
    ['takerBuyVolume', 'quoteVolume', 'trades'].every((key) => {
      const value = b[key as keyof CandleBar];
      return (
        value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
      );
    })
  );
}
export function compareCandleMonth(
  stored: CandleBar[],
  archive: CandleBar[],
  from: number,
  to: number,
  interval: '1h' | '4h'
) {
  const delta = interval === '1h' ? HOUR_MS : 4 * HOUR_MS;
  const report = {
    stored: stored.length,
    archive: archive.length,
    matched: 0,
    mismatched: 0,
    missingStored: 0,
    missingArchive: 0,
    missingBoth: 0,
    duplicateStored: 0,
    duplicateArchive: 0,
    invalidStored: 0,
    invalidArchive: 0,
    takerCompared: 0,
    takerUnavailable: 0,
    examples: [] as { timestamp: number; reason: string; fields?: string[] }[],
  };
  const example = (timestamp: number, reason: string, fields?: string[]) => {
    if (report.examples.length < 20)
      report.examples.push({ timestamp, reason, ...(fields ? { fields } : {}) });
  };
  const index = (bars: CandleBar[], side: 'Stored' | 'Archive') => {
    const result = new Map<number, CandleBar[]>();
    for (const b of bars) {
      if (
        !Number.isFinite(b.timestamp) ||
        b.timestamp % delta !== 0 ||
        b.timestamp < from ||
        b.timestamp >= to
      ) {
        report[`invalid${side}`]++;
        example(b.timestamp, `invalid${side}`);
        continue;
      }
      const list = result.get(b.timestamp) ?? [];
      list.push(b);
      result.set(b.timestamp, list);
      if (list.length > 1) report[`duplicate${side}`]++;
      if (!validCandle(b)) {
        report[`invalid${side}`]++;
        example(b.timestamp, `invalid${side}`);
      }
    }
    return result;
  };
  const s = index(stored, 'Stored');
  const a = index(archive, 'Archive');
  for (let t = Math.ceil(from / delta) * delta; t < to; t += delta) {
    const sb = s.get(t);
    const ab = a.get(t);
    if (!sb && !ab) {
      report.missingBoth++;
      example(t, 'missingBoth');
      continue;
    }
    if (!sb) {
      report.missingStored++;
      example(t, 'missingStored');
      continue;
    }
    if (!ab) {
      report.missingArchive++;
      example(t, 'missingArchive');
      continue;
    }
    if (sb.length !== 1 || ab.length !== 1) {
      example(t, 'duplicate');
      continue;
    }
    const left = sb[0];
    const right = ab[0];
    if (!validCandle(left) || !validCandle(right)) continue;
    const fields: string[] = CANDLE_FIELDS.filter((k) => !approximately(left[k], right[k]));
    for (const key of ['takerBuyVolume', 'quoteVolume', 'trades'] as const) {
      const leftValue = left[key];
      const rightValue = right[key];
      if (leftValue !== undefined && rightValue !== undefined) {
        if (!approximately(leftValue, rightValue)) fields.push(key);
        if (key === 'takerBuyVolume') report.takerCompared++;
      } else if (key === 'takerBuyVolume') report.takerUnavailable++;
    }
    if (fields.length) {
      report.mismatched++;
      example(t, 'mismatched', fields);
    } else report.matched++;
  }
  return report;
}
export interface CandleAdapters {
  stored: (
    venue: 'spot' | 'perp',
    symbol: string,
    interval: '1h' | '4h',
    from: number,
    to: number
  ) => Promise<CandleBar[]>;
  archive: (spec: ArchiveFileSpec) => Promise<{ bars: CandleBar[]; invalidLines: number } | null>;
}
export async function auditCandles(
  range: { from: number; to: number },
  deps: CandleAdapters,
  write: (r: Record<string, unknown>) => Promise<void>
) {
  if (
    !Number.isSafeInteger(range.from) ||
    !Number.isSafeInteger(range.to) ||
    range.from < D_FROM ||
    range.to > D_TO ||
    range.from >= range.to
  )
    throw new AuditValidationError('candles dates must be inside D [2022-01-01, 2026-07-01)');
  const totals = {
    months: 0,
    unavailableMonths: 0,
    matched: 0,
    mismatched: 0,
    missingStored: 0,
    missingArchive: 0,
    missingBoth: 0,
    duplicateStored: 0,
    duplicateArchive: 0,
    invalidStored: 0,
    invalidArchive: 0,
  };
  for (
    let month = Date.UTC(
      new Date(range.from).getUTCFullYear(),
      new Date(range.from).getUTCMonth(),
      1
    );
    month < range.to;
    month = Date.UTC(new Date(month).getUTCFullYear(), new Date(month).getUTCMonth() + 1, 1)
  ) {
    const next = Date.UTC(new Date(month).getUTCFullYear(), new Date(month).getUTCMonth() + 1, 1);
    const from = Math.max(month, range.from);
    const to = Math.min(next, range.to);
    for (const venue of ['spot', 'perp'] as const)
      for (const symbol of SIGNAL_SYMBOLS)
        for (const interval of ['1h', '4h'] as const) {
          const spec: ArchiveFileSpec = {
            dataset: venue === 'spot' ? 'spotKlines' : 'klines',
            symbol,
            interval,
            date: new Date(month).toISOString().slice(0, 7),
          };
          let data: Awaited<ReturnType<CandleAdapters['archive']>> = null;
          let unavailableReason = 'archive month unavailable';
          try {
            data = await deps.archive(spec);
          } catch (error) {
            unavailableReason = `archive read failed: ${externalFailureTag(error)}`;
          }
          totals.months++;
          if (!data) {
            totals.unavailableMonths++;
            await write({
              venue,
              symbol,
              interval,
              month: spec.date,
              from,
              to,
              unavailable: true,
              reason: unavailableReason,
              matched: 0,
            });
            continue;
          }
          const stored = await deps.stored(venue, symbol, interval, from, to);
          const result = compareCandleMonth(
            stored,
            data.bars.filter((b) => b.timestamp >= from && b.timestamp < to),
            from,
            to,
            interval
          );
          result.invalidArchive += data.invalidLines;
          for (const key of [
            'matched',
            'mismatched',
            'missingStored',
            'missingArchive',
            'missingBoth',
            'duplicateStored',
            'duplicateArchive',
            'invalidStored',
            'invalidArchive',
          ] as const)
            totals[key] += result[key];
          await write({
            venue,
            symbol,
            interval,
            month: spec.date,
            from,
            to,
            unavailable: false,
            ...result,
          });
        }
  }
  return totals;
}
export function parseAuditArgs(args: string[]) {
  const command = args[0];
  if (command !== 'replay' && command !== 'candles')
    throw new AuditValidationError(
      'usage: round4-audit.ts replay|candles --out PATH [--from YYYY-MM-DD --to YYYY-MM-DD --cache PATH]'
    );
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (
      !['--out', '--from', '--to', '--cache'].includes(key) ||
      !value ||
      value.startsWith('--') ||
      key in flags
    )
      throw new AuditValidationError(`invalid or duplicate argument: ${key}`);
    flags[key] = value;
  }
  if (!flags['--out']) throw new AuditValidationError('--out PATH is required');
  if (command === 'replay' && ['--from', '--to', '--cache'].some((k) => k in flags))
    throw new AuditValidationError(
      'replay audits EVERY stored row; date/cache flags only apply to candles'
    );
  function date(value: string | undefined, fallback: number) {
    if (!value) return fallback;
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(parsed) ||
      new Date(parsed).toISOString().slice(0, 10) !== value
    )
      throw new AuditValidationError(`invalid UTC date: ${value}`);
    return parsed;
  }
  const from = date(flags['--from'], D_FROM);
  const to = date(flags['--to'], D_TO);
  if (from < D_FROM || to > D_TO || from >= to)
    throw new AuditValidationError('candles dates must be inside D [2022-01-01, 2026-07-01)');
  return { command, out: flags['--out'], from, to, cache: flags['--cache'] };
}
