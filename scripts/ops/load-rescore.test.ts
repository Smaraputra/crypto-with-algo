import { describe, expect, it } from 'vitest';

import { pointMeasures } from '@/lib/signals/track-record/measures';
import { trackRunSchema } from '@/lib/signals/track-record/schema';
import { TRACK_RECORD_RUN_ID } from '@/lib/signals/track-record/types';

import { cellMeasures, type LiveRow } from '../research/live-record-stats';
import { seededRandom } from '../research/carry-sim';
import {
  bucketStartOf,
  buildBucketDocs,
  buildRun,
  cellTrackFromReport,
  parseArgs,
  RESCORE_CUTOFFS,
  symbolTrack,
  tierAtCutoffs,
  validateRows,
  type RescoreReport,
} from './load-rescore';

const HOUR = 3_600_000;
const START = Date.UTC(2025, 9, 1);

/** A deterministic hourly series for one symbol in the day_trading 1h cell. */
function hourlyRows(symbol: string, count: number, seed: number): LiveRow[] {
  const random = seededRandom(seed);
  const rows: LiveRow[] = [];
  for (let i = 0; i < count; i++) {
    const score = (random() - 0.5) * 100;
    rows.push({
      symbol,
      interval: '1h',
      tradingStyle: 'day_trading',
      tier: tierAtCutoffs(score, RESCORE_CUTOFFS),
      score,
      configVersion: 8,
      candleTimestamp: START + i * HOUR,
      horizonBars: 24,
      forwardReturnPercent: (random() - 0.5) * 4,
    });
  }
  return rows;
}

function reportCell(overrides: Partial<RescoreReport['cells'][number]> = {}): RescoreReport['cells'][number] {
  return {
    style: 'day_trading',
    interval: '1h',
    horizonBars: 24,
    costPercent: 0.16,
    rows: 89_520,
    measures: { buyN: 7_874, sellN: 7_987, bh: 0.441, net: -0.236, spearman: -0.047 },
    intervals: { bh: { loLevel: 0.387, hiLevel: 0.495 }, net: { loLevel: -0.72, hiLevel: 0.231 } },
    verdict: { verdict: 'NO DETECTABLE EDGE', level: 1 - 0.05 / 6 },
    parity: { matched: 1_740, sameTierShare: 0.9994, scoreCorrelation: 0.99999 },
    ...overrides,
  };
}

describe('parseArgs', () => {
  it('requires both inputs and reads the options', () => {
    expect(() => parseArgs(['--rows', 'a.gz'])).toThrow('--report is required');
    expect(parseArgs(['--rows', 'a.gz', '--report', 'r.json', '--resamples', '500', '--dry-run'])).toEqual({
      rowsPath: 'a.gz',
      reportPath: 'r.json',
      resamples: 500,
      dryRun: true,
    });
  });

  it('rejects unknown flags and tiny resample counts', () => {
    expect(() => parseArgs(['--rows', 'a', '--report', 'b', '--x'])).toThrow('Unknown flag');
    expect(() => parseArgs(['--rows', 'a', '--report', 'b', '--resamples', '10'])).toThrow('--resamples');
  });
});

describe('tierAtCutoffs', () => {
  it('uses strict comparisons like scorer.getTier', () => {
    expect(tierAtCutoffs(28, RESCORE_CUTOFFS)).toBe('neutral');
    expect(tierAtCutoffs(28.0001, RESCORE_CUTOFFS)).toBe('buy');
    expect(tierAtCutoffs(36, RESCORE_CUTOFFS)).toBe('buy');
    expect(tierAtCutoffs(36.5, RESCORE_CUTOFFS)).toBe('strong_buy');
    expect(tierAtCutoffs(-30, RESCORE_CUTOFFS)).toBe('sell');
    expect(tierAtCutoffs(-40, RESCORE_CUTOFFS)).toBe('strong_sell');
  });
});

describe('validateRows', () => {
  const good = hourlyRows('BTCUSDT', 3, 1);

  it('accepts version 8 rows of a re-score cell with consistent tiers', () => {
    expect(() => validateRows(good)).not.toThrow();
  });

  it('rejects another version, a cell outside the re-score, or a tier that disagrees with the score', () => {
    expect(() => validateRows([{ ...good[0], configVersion: 7 }])).toThrow('configVersion 7');
    expect(() => validateRows([{ ...good[0], interval: '1m', tradingStyle: 'scalping' }])).toThrow('outside');
    expect(() => validateRows([{ ...good[0], score: 50, tier: 'neutral' }])).toThrow('does not match');
  });
});

describe('bucketStartOf', () => {
  it('buckets intraday bars by UTC day and daily bars by UTC month', () => {
    expect(bucketStartOf('5m', Date.UTC(2026, 2, 4, 23, 55))).toBe(Date.UTC(2026, 2, 4));
    expect(bucketStartOf('1d', Date.UTC(2026, 2, 4))).toBe(Date.UTC(2026, 2, 1));
  });
});

describe('buildBucketDocs', () => {
  it('splits a series into ascending day buckets with tier codes', () => {
    const rows = hourlyRows('ETHUSDT', 50, 2);
    const docs = buildBucketDocs(TRACK_RECORD_RUN_ID, [...rows].reverse());
    expect(docs.map((d) => d.t.length)).toEqual([24, 24, 2]);
    expect(docs[0].bucketStart).toBe(START);
    expect(docs[0].t).toEqual(rows.slice(0, 24).map((r) => r.candleTimestamp));
    expect(docs[1].score[0]).toBe(rows[24].score);
    expect(docs[1].fwd[0]).toBe(rows[24].forwardReturnPercent);
    const codes = { strong_sell: -2, sell: -1, neutral: 0, buy: 1, strong_buy: 2 } as const;
    expect(docs[0].tier).toEqual(rows.slice(0, 24).map((r) => codes[r.tier as keyof typeof codes]));
  });

  it('refuses a duplicated bar', () => {
    const rows = hourlyRows('ETHUSDT', 2, 3);
    expect(() => buildBucketDocs(TRACK_RECORD_RUN_ID, [...rows, rows[1]])).toThrow('Duplicate bar');
  });
});

describe('pointMeasures parity with the live-record study', () => {
  it('reproduces cellMeasures bh and net on the same rows', () => {
    const rows = hourlyRows('BTCUSDT', 2_000, 4);
    const ours = pointMeasures(rows, 0.16);
    const theirs = cellMeasures(rows, 0.16);
    expect(ours.bh).toBeCloseTo(theirs.bh, 12);
    expect(ours.net).toBeCloseTo(theirs.net, 12);
    expect(ours.buyN).toBe(theirs.buyN);
    expect(ours.sellN).toBe(theirs.sellN);
  });
});

describe('symbolTrack', () => {
  const rows = hourlyRows('SOLUSDT', 1_500, 5);
  const track = symbolTrack(rows, 0.16, 24, 200);

  it('reports the point measures, span and months of the rows', () => {
    expect(track.symbol).toBe('SOLUSDT');
    expect(track.first).toBe(rows[0].candleTimestamp);
    expect(track.last).toBe(rows[rows.length - 1].candleTimestamp);
    expect(track.measures).toEqual(pointMeasures(rows, 0.16));
    expect(track.months.map((m) => m.month)).toEqual(['2025-10', '2025-11', '2025-12']);
    expect(track.months.reduce((n, m) => n + m.calls, 0)).toBe(track.measures.calls);
  });

  it('brackets each point estimate with its bootstrap interval', () => {
    for (const key of ['right', 'bh', 'net'] as const) {
      const pair = track.intervals[key];
      const point = key === 'right' ? track.measures.right : key === 'bh' ? track.measures.bh : track.measures.net;
      expect(pair).not.toBeNull();
      expect(pair!.lo).toBeLessThanOrEqual(point as number);
      expect(pair!.hi).toBeGreaterThanOrEqual(point as number);
    }
  });

  it('is deterministic for a seed', () => {
    expect(symbolTrack(rows, 0.16, 24, 200).intervals).toEqual(track.intervals);
    expect(track.liveSince).toBeNull();
  });

  it('leaves an interval null when a resample cannot compute it', () => {
    const buysOnly = hourlyRows('DOTUSDT', 200, 6).map((r) => ({ ...r, score: 40, tier: 'strong_buy' }));
    const t = symbolTrack(buysOnly, 0.16, 24, 100);
    expect(t.intervals.bh).toBeNull();
    expect(t.intervals.right).not.toBeNull();
  });
});

describe('cellTrackFromReport', () => {
  it('copies the pooled verdict and parity verbatim', () => {
    const cell = cellTrackFromReport(reportCell(), []);
    expect(cell.pooled).toMatchObject({ bh: 0.441, bhLo: 0.387, bhHi: 0.495, net: -0.236, verdict: 'NO DETECTABLE EDGE' });
    expect(cell.parity).toEqual({ matched: 1_740, sameTierShare: 0.9994, scoreCorrelation: 0.99999 });
    expect(cell.costPercent).toBe(0.16);
  });

  it('rejects a cell or horizon the re-score does not define', () => {
    expect(() => cellTrackFromReport(reportCell({ interval: '1m', style: 'scalping' }), [])).toThrow('outside');
    expect(() => cellTrackFromReport(reportCell({ horizonBars: 12 }), [])).toThrow('Horizon mismatch');
  });
});

describe('buildRun', () => {
  it('builds a schema-valid run and buckets holding every row', () => {
    const rows = [...hourlyRows('BTCUSDT', 300, 7), ...hourlyRows('ETHUSDT', 300, 8)];
    const report: RescoreReport = {
      reportKind: 'v8-rescore',
      rowsSha256: 'a'.repeat(64),
      gitCommit: '663e4a1680293dc0f4f37606d48373f9659be312',
      configVersion: 8,
      verdictLevel: 1 - 0.05 / 6,
      cells: [reportCell()],
    };
    const lines: Array<Record<string, unknown>> = [];
    const liveSince = new Map([['day_trading|1h', new Map([['ETHUSDT', START + 299 * HOUR]])]]);
    const { run, buckets } = buildRun(rows, report, 100, 'b'.repeat(64), liveSince, (l) => lines.push(l));
    expect(() => trackRunSchema.parse(run)).not.toThrow();
    expect(run.runId).toBe(TRACK_RECORD_RUN_ID);
    expect(run.cutoffs).toEqual({ buy: 28, strong: 36 });
    expect(run.cells[0].symbols.map((s) => s.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(run.cells[0].symbols.map((s) => s.liveSince)).toEqual([null, START + 299 * HOUR]);
    expect(buckets.reduce((n, b) => n + b.t.length, 0)).toBe(rows.length);
    expect(lines).toHaveLength(2);
  });

  it('refuses a report of another version', () => {
    const report = {
      reportKind: 'v8-rescore' as const,
      rowsSha256: 'a'.repeat(64),
      gitCommit: '663e4a1',
      configVersion: 7,
      verdictLevel: 0.99,
      cells: [],
    };
    expect(() => buildRun(hourlyRows('BTCUSDT', 2, 9), report, 100, 'b'.repeat(64))).toThrow('configVersion 7');
  });
});
