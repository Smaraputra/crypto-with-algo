// @vitest-environment node
import { LAB_V3_UNIVERSE } from '@/lib/signals/lab/candidates';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { describe, expect, it } from 'vitest';
import {
  auditCandles,
  auditReplay,
  compareCandleMonth,
  parseAuditArgs,
  replayRow,
  type ReplayAdapters,
  type ReplayRow,
} from './round4-audit-core';

const T = Date.UTC(2026, 5, 1);
const row = (extra: Partial<ReplayRow> = {}): ReplayRow => ({
  _id: 'one',
  candidate: 'L2',
  version: 'lab-v1',
  hypothesis: 'L2-1h',
  timeframe: '1h',
  barClose: T,
  scores: { BTCUSDT: 75 },
  skipped: SIGNAL_SYMBOLS.slice(1).map((symbol) => ({ symbol, reason: 'rv_skipped' })),
  inputs: { rvBarTime: T - 28_800_000, v8: { BTCUSDT: { score: 50 } } },
  ...extra,
});
const deps = (extra: Partial<ReplayAdapters> = {}): ReplayAdapters => ({
  rv: async () => ({ ranked: [{ symbol: 'BTCUSDT', compositeZ: 2, rank: 1 }] }),
  bars: async () => [],
  ratios: async () => [],
  prior: async () => [],
  ...extra,
});
const bar = (timestamp = Date.UTC(2022, 0, 1), close = 10) => ({
  timestamp,
  open: 10,
  high: 11,
  low: 9,
  close,
  volume: 20,
  takerBuyVolume: 5,
});

describe('Round 4 replay', () => {
  it('redacts external adapter error text while preserving a known error name and numeric code', async () => {
    const error = Object.assign(new Error('mongodb://owner:credential-fragment@private-host'), {
      name: 'MongoServerError',
      code: 18,
    });
    const result = await replayRow(
      row(),
      deps({
        rv: async () => {
          throw error;
        },
      })
    );
    expect(result).toMatchObject({
      status: 'unreproducible',
      reason: 'historical input read or replay failed: MongoServerError (code 18)',
    });
    expect(JSON.stringify(result)).not.toContain('credential-fragment');
  });
  it('replays pinned L2 inputs without reading stored scores as expected output', async () => {
    expect(await replayRow(row(), deps())).toMatchObject({
      status: 'matched',
      provenance: 'exact',
      recomputed: { scores: { BTCUSDT: 75 } },
    });
    expect(await replayRow(row({ scores: { BTCUSDT: 74 } }), deps())).toMatchObject({
      status: 'mismatched',
      differences: ['scores.BTCUSDT'],
    });
  });
  it('replays L1 pinned RV values, L3 flat variance and immutable L4 alternating ratios', async () => {
    const l1 = row({
      candidate: 'L1',
      hypothesis: 'L1-8h',
      timeframe: '8h',
      scores: { BTCUSDT: 2 },
    });
    expect(await replayRow(l1, deps())).toMatchObject({ status: 'matched', provenance: 'exact' });
    const l3 = row({
      candidate: 'L3',
      hypothesis: 'L3-8h',
      timeframe: '8h',
      scores: Object.fromEntries(SIGNAL_SYMBOLS.map((symbol) => [symbol, 0])),
      skipped: [],
      inputs: {
        lastBarOpenTime: Object.fromEntries(
          SIGNAL_SYMBOLS.map((symbol) => [symbol, T - 3_600_000])
        ),
        errors: {},
      },
    });
    const bars = Array.from({ length: 169 }, (_, i) => bar(T - (169 - i) * 3_600_000));
    expect(await replayRow(l3, deps({ bars: async () => bars }))).toMatchObject({
      status: 'matched',
      provenance: 'reconstructed',
    });
    const cutoff = T - 4 * 3_600_000;
    const points = Array.from({ length: 180 }, (_, i) => ({
      timestamp: cutoff - (179 - i) * 4 * 3_600_000,
      longShortRatio: i % 2 ? 3 : 1,
    }));
    const l4 = row({
      candidate: 'L4',
      hypothesis: 'L4-8h',
      timeframe: '8h',
      scores: Object.fromEntries(SIGNAL_SYMBOLS.map((symbol) => [symbol, -0.9972183534434393])),
      skipped: [],
      inputs: {
        points: Object.fromEntries(
          SIGNAL_SYMBOLS.map((symbol) => [
            symbol,
            { z: 0.9972183534434393, latestTimestamp: cutoff, storedPoints: 180 },
          ])
        ),
        windowSizes: {},
        errors: {},
      },
    });
    expect(await replayRow(l4, deps({ ratios: async () => points }))).toMatchObject({
      status: 'matched',
      provenance: 'reconstructed',
    });
  });
  it('detects even a small score value difference in frozen replay', async () => {
    expect(await replayRow(row({ scores: { BTCUSDT: 75 + 1e-11 } }), deps())).toMatchObject({
      status: 'mismatched',
      differences: ['scores.BTCUSDT'],
    });
  });
  it('reports missing inputs, missing pinned RV, malformed scores and unknown candidates precisely', async () => {
    expect(await replayRow(row({ inputs: {} }), deps())).toMatchObject({
      status: 'unreproducible',
      reason: 'missing inputs.rvBarTime',
    });
    expect(await replayRow(row(), deps({ rv: async () => null }))).toMatchObject({
      status: 'unreproducible',
      reason: 'pinned rvsignals record missing',
    });
    expect(await replayRow(row({ scores: { BTCUSDT: NaN } }), deps())).toMatchObject({
      status: 'unreproducible',
      reason: 'invalid stored scores',
    });
    expect(await replayRow(row({ candidate: 'future' }), deps())).toMatchObject({
      status: 'unreproducible',
      reason: 'unsupported candidate/version/hypothesis',
    });
  });
  it('checks N2 hashes before loading or fitting when absent', async () => {
    let reads = 0;
    expect(
      await replayRow(
        row({
          candidate: 'N2',
          version: 'lab-v2',
          hypothesis: 'N2-1w',
          timeframe: '1w',
          inputs: {},
        }),
        deps({
          bars: async () => {
            reads++;
            return [];
          },
        })
      )
    ).toMatchObject({ status: 'unreproducible', reason: 'missing or invalid inputs.inputsSha256' });
    expect(reads).toBe(0);
  });
  it('rejects a changed N2 input hash before fitting', async () => {
    expect(
      await replayRow(
        row({
          candidate: 'N2',
          version: 'lab-v2',
          hypothesis: 'N2-1w',
          timeframe: '1w',
          inputs: { inputsSha256: '0'.repeat(64) },
        }),
        deps()
      )
    ).toMatchObject({ status: 'unreproducible', reason: 'inputsSha256 mismatch' });
  });
  it('replays hash-verified N2 and N3 empty input arrays with frozen literal outcomes', async () => {
    const inputsSha256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
    const n2 = row({
      candidate: 'N2',
      version: 'lab-v2',
      hypothesis: 'N2-1w',
      timeframe: '1w',
      scores: {},
      skipped: [],
      inputs: { inputsSha256 },
    });
    expect(await replayRow(n2, deps())).toMatchObject({
      status: 'matched',
      provenance: 'exact',
      recomputed: { scores: {}, skipped: [] },
    });
    const n3 = row({
      candidate: 'N3',
      version: 'lab-v2',
      hypothesis: 'N3-1d',
      timeframe: '1d',
      scores: {},
      skipped: SIGNAL_SYMBOLS.map((symbol) => ({ symbol, reason: 'va_incomplete' })),
      inputs: { inputsSha256 },
    });
    expect(await replayRow(n3, deps())).toMatchObject({
      status: 'matched',
      provenance: 'exact',
      recomputed: {
        scores: {},
        skipped: SIGNAL_SYMBOLS.map((symbol) => ({ symbol, reason: 'va_incomplete' })),
      },
    });
  });
  it('detects a skipped-reason mismatch independently of matching scores', async () => {
    expect(await replayRow(row({ skipped: [] }), deps())).toMatchObject({
      status: 'mismatched',
      differences: ['skipped'],
    });
  });
  it('handles unsupported prototype-like candidate names without losing cursor rows', async () => {
    async function* rows() {
      yield row({ candidate: '__proto__' });
    }
    expect(await auditReplay(rows(), deps(), async () => {})).toMatchObject({
      total: 1,
      unreproducible: 1,
    });
  });
  it('replays F1 stored raw scores through an empty target and prior stagger', async () => {
    const rawScores = Object.fromEntries(LAB_V3_UNIVERSE.map((symbol) => [symbol, 1]));
    expect(
      await replayRow(
        row({
          candidate: 'F1',
          version: 'lab-v3',
          hypothesis: 'F1-1d',
          timeframe: '1d',
          scores: {},
          skipped: [],
          inputs: { rawScores, targetBook: {}, priorDaysFound: 1 },
        }),
        deps({ prior: async () => [row({ inputs: { targetBook: {} }, barClose: T - 86_400_000 })] })
      )
    ).toMatchObject({
      status: 'unreproducible',
      bookReplay: { status: 'matched', scores: {}, target: {} },
      scope:
        'stored raw funding scores -> target -> stagger; raw funding settlements not rederived',
    });
  });
  it('does not fabricate F1 skip reasons for missing raw funding history', async () => {
    expect(
      await replayRow(
        row({
          candidate: 'F1',
          version: 'lab-v3',
          hypothesis: 'F1-1d',
          timeframe: '1d',
          inputs: { rawScores: {}, targetBook: {} },
        }),
        deps()
      )
    ).toMatchObject({
      status: 'unreproducible',
      reason: expect.stringContaining('funding/delisting history unavailable'),
    });
  });
  it('counts every cursor row once and caps examples', async () => {
    async function* rows() {
      yield row();
      yield row({ scores: { BTCUSDT: -1 } });
      yield row({ candidate: 'unknown' });
    }
    const written: string[] = [];
    const report = await auditReplay(
      rows(),
      deps(),
      async (result) => {
        written.push(result.status);
      },
      1
    );
    expect(written).toEqual(['matched', 'mismatched', 'unreproducible']);
    expect(report).toMatchObject({
      total: 3,
      matched: 1,
      mismatched: 1,
      unreproducible: 1,
      candidates: {
        L2: { total: 2, matched: 1, mismatched: 1, unreproducible: 0 },
        unknown: { total: 1, matched: 0, mismatched: 0, unreproducible: 1 },
      },
    });
    expect(report.examples).toHaveLength(1);
  });
  it('preserves frozen S1/S2 blocking from prior late rows and the strict eight-hour boundary', async () => {
    for (const candidate of ['S1', 'S2']) {
      const length = candidate === 'S1' ? 87 : 71;
      const bars = Array.from({ length: 720 }, (_, i) => ({
        timestamp: T - (720 - i) * 3_600_000,
        open: 90,
        high: 100,
        low: 80,
        close: 90,
        volume: 1000,
        takerBuyVolume: 500,
      }));
      const offset = 720 - length;
      if (candidate === 'S1') {
        Object.assign(bars[offset + 20], { open: 80, high: 85, low: 50, close: 75 });
        Object.assign(bars[offset + 41], { open: 70, high: 75, low: 35, close: 40 });
        Object.assign(bars[offset + 65], { open: 90, high: 150, low: 85, close: 95 });
        Object.assign(bars[offset + 86], {
          open: 140,
          high: 165,
          low: 135,
          close: 160,
          takerBuyVolume: 750,
        });
      } else {
        bars[offset + 25].high = 150;
        bars[offset + 50].high = 180;
        for (let i = 26; i <= 50; i++) bars[offset + i].takerBuyVolume = 300;
      }
      const side = candidate === 'S1' ? 1 : -1;
      const actual = row({
        candidate,
        version: 'lab-v4',
        hypothesis: `${candidate}-1h`,
        inputs: { windowBars: 720, lastBarOpen: T - 3_600_000 },
        scores: Object.fromEntries(SIGNAL_SYMBOLS.slice(1).map((s) => [s, side])),
        skipped: [{ symbol: 'BTCUSDT', reason: 'in_trade' }],
      });
      expect(
        await replayRow(
          actual,
          deps({
            bars: async () => bars,
            prior: async () => [
              row({ barClose: T - 3_600_000, late: true, scores: { BTCUSDT: -1 } }),
              row({ barClose: T - 8 * 3_600_000, scores: { ETHUSDT: 1 } }),
            ],
          })
        )
      ).toMatchObject({
        status: 'matched',
        provenance: 'reconstructed',
        recomputed: {
          scores: Object.fromEntries(SIGNAL_SYMBOLS.slice(1).map((s) => [s, side])),
          skipped: [{ symbol: 'BTCUSDT', reason: 'in_trade' }],
        },
      });
    }
  });
  it('replays a nonzero F1 prior target with a literal one-seventh stagger weight', async () => {
    const rawScores = Object.fromEntries(LAB_V3_UNIVERSE.map((symbol) => [symbol, 1]));
    const f1 = row({
      candidate: 'F1',
      version: 'lab-v3',
      hypothesis: 'F1-1d',
      timeframe: '1d',
      scores: { BTCUSDT: 0.09999999999999999 },
      skipped: [],
      inputs: { rawScores, targetBook: {} },
    });
    expect(
      await replayRow(
        f1,
        deps({
          prior: async () => [
            row({ barClose: T - 86_400_000, inputs: { targetBook: { BTCUSDT: 0.7 } } }),
          ],
        })
      )
    ).toMatchObject({
      status: 'unreproducible',
      bookReplay: { status: 'matched', scores: { BTCUSDT: 0.09999999999999999 } },
    });
    expect(
      await replayRow(
        { ...f1, scores: { BTCUSDT: 0.2 } },
        deps({
          prior: async () => [
            row({ barClose: T - 86_400_000, inputs: { targetBook: { BTCUSDT: 0.7 } } }),
          ],
        })
      )
    ).toMatchObject({ bookReplay: { status: 'mismatched', differences: ['scores.BTCUSDT'] } });
  });
  it('marks omitted L3 input metadata unreproducible', async () => {
    expect(
      await replayRow(
        row({ candidate: 'L3', hypothesis: 'L3-8h', timeframe: '8h', inputs: {} }),
        deps()
      )
    ).toMatchObject({ status: 'unreproducible', reason: 'missing inputs.lastBarOpenTime' });
  });
  it('does not reconstruct an unrecoverable historical REST failure from present candles', async () => {
    expect(
      await replayRow(
        row({
          candidate: 'L3',
          hypothesis: 'L3-8h',
          timeframe: '8h',
          inputs: { errors: { BTCUSDT: 'timeout' } },
        }),
        deps()
      )
    ).toMatchObject({
      status: 'unreproducible',
      reason: 'historical REST failure response unavailable',
    });
  });
});

describe('Round 4 candle comparison', () => {
  it('redacts external archive error messages and arbitrary error names or codes', async () => {
    const reports: Record<string, unknown>[] = [];
    await auditCandles(
      { from: Date.UTC(2022, 0, 1), to: Date.UTC(2022, 0, 2) },
      {
        stored: async () => [],
        archive: async () => {
          throw { name: 'credential-fragment', message: 'secret-uri', code: 'secret-code' };
        },
      },
      async (r) => {
        reports.push(r);
      }
    );
    expect(reports[0]).toMatchObject({ unavailable: true, reason: 'archive read failed: Error' });
    expect(JSON.stringify(reports)).not.toMatch(/credential-fragment|secret-uri|secret-code/);
  });
  it('separates missing, duplicate, invalid and numerically mismatched bars', () => {
    const t = Date.UTC(2022, 0, 1);
    expect(
      compareCandleMonth(
        [bar(t), bar(t), bar(t + 3_600_000, NaN), bar(t + 7_200_000, 9.5)],
        [bar(t), bar(t + 3_600_000), bar(t + 7_200_000), bar(t + 10_800_000)],
        t,
        t + 14_400_000,
        '1h'
      )
    ).toMatchObject({
      matched: 0,
      mismatched: 1,
      missingStored: 1,
      missingArchive: 0,
      duplicateStored: 1,
      duplicateArchive: 0,
      invalidStored: 1,
      invalidArchive: 0,
    });
  });
  it('uses combined absolute and relative tolerance and checks available taker volume', () => {
    const t = Date.UTC(2022, 0, 1);
    expect(
      compareCandleMonth([bar(t, 10 + 1e-10)], [bar(t)], t, t + 3_600_000, '1h')
    ).toMatchObject({ matched: 1, mismatched: 0 });
    expect(
      compareCandleMonth([{ ...bar(t), takerBuyVolume: 6 }], [bar(t)], t, t + 3_600_000, '1h')
    ).toMatchObject({ matched: 0, mismatched: 1 });
  });
  it('compares OHLCV when stored taker volume is absent and rejects invalid available optional fields', () => {
    const t = Date.UTC(2022, 0, 1);
    expect(
      compareCandleMonth(
        [{ ...bar(t), takerBuyVolume: undefined }],
        [bar(t)],
        t,
        t + 3_600_000,
        '1h'
      )
    ).toMatchObject({ matched: 1, takerCompared: 0, takerUnavailable: 1 });
    expect(
      compareCandleMonth(
        [{ ...bar(t), trades: NaN }],
        [{ ...bar(t), trades: 5 }],
        t,
        t + 3_600_000,
        '1h'
      )
    ).toMatchObject({ matched: 0, mismatched: 0, invalidStored: 1 });
  });
  it('routes each venue to its own archive dataset and marks absent months unavailable', async () => {
    const requested: string[] = [];
    const reports: unknown[] = [];
    await auditCandles(
      { from: Date.UTC(2022, 0, 1), to: Date.UTC(2022, 0, 2) },
      {
        stored: async () => [bar()],
        archive: async (spec) => {
          requested.push(spec.dataset);
          return null;
        },
      },
      async (r) => {
        reports.push(r);
      }
    );
    expect(requested).toHaveLength(40);
    expect(requested.filter((v) => v === 'spotKlines')).toHaveLength(20);
    expect(requested.filter((v) => v === 'klines')).toHaveLength(20);
    expect(reports[0]).toMatchObject({ venue: 'spot', unavailable: true, matched: 0 });
  });
  it('accepts exact D boundaries, rejects malformed or out-of-D dates and unknown flags', () => {
    expect(parseAuditArgs(['candles', '--out', '/tmp/audit.json'])).toMatchObject({
      from: Date.UTC(2022, 0, 1),
      to: Date.UTC(2026, 6, 1),
    });
    for (const args of [
      ['--from', '2021-12-31'],
      ['--to', '2026-07-02'],
      ['--from', '2022-02-30'],
      ['--from', '2023-01-01', '--to', '2022-01-01'],
      ['--limit', '1'],
    ]) {
      expect(() => parseAuditArgs(['candles', '--out', '/tmp/a.json', ...args])).toThrow();
    }
  });
});
