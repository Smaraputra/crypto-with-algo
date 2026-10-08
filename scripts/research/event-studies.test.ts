// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import { benjaminiYekutieli } from './ic-stats';
import { validateEventStudyReport, type EventStudyReport } from './report-schema';
import { syntheticDataset, type SyntheticSymbol } from './event-studies-synthetic';
import {
  BOOTSTRAP,
  DAY_MS,
  EVENT_SYMBOLS,
  HOUR_MS,
  MIN_TRAILING_HOURS,
  PREREGISTERED_CONFIG,
  ROUND_TRIP_COST,
  TRAILING_HOURS,
  SortedWindow,
  buildHourlyPanel,
  calendarOf,
  cellStatistics,
  circularBlockDays,
  dailyRealisedVariance,
  dayBootstrapMeans,
  dayBootstrapStatistic,
  detectE1,
  detectE2,
  detectE3,
  evaluateGates,
  evaluateStressFlag,
  fundingPaid,
  gridStartOf,
  keepEvents,
  medianOf,
  periodAgreement,
  quantileSorted,
  ratioRead,
  reportedBlock,
  runEventStudies,
  settlementQuantiles,
  summariseDraws,
  symbolAgreement,
  trailingQuantiles,
  volatilityRatio,
  type DetectedEvent,
  type EventStudyConfig,
  type EventStudyResult,
  type GroupMean,
  type HourlyPanel,
  type KeptEvent,
  marketWideStressHours,
} from './event-studies';

const H = HOUR_MS;
const T0 = Date.UTC(2024, 0, 1);
const SYMBOL = 'AAAUSDT';

interface Bar {
  o: number;
  c: number;
  v: number;
}

const bar = (r: number, v = 1): Bar => ({ o: 100, c: 100 * Math.exp(r), v });

/** A panel from per-hour bars (null = no row) starting at `start`, OI stamped at minute 55. */
function panelFrom(
  bars: (Bar | null)[],
  opts: { oi?: (number | null)[]; funding?: { t: number; rate: number }[]; start?: number; symbol?: string } = {}
): HourlyPanel {
  const start = opts.start ?? T0;
  const klines = bars.flatMap((b, h) => (b ? [{ t: start + h * H, o: b.o, c: b.c, v: b.v }] : []));
  const metrics = (opts.oi ?? []).flatMap((v, h) =>
    v === null ? [] : [{ t: start + h * H + 55 * 60_000, openInterest: v }]
  );
  return buildHourlyPanel(opts.symbol ?? SYMBOL, klines, metrics, opts.funding ?? [], start, start + bars.length * H);
}

function ev(type: DetectedEvent['type'], hour: number, d: -1 | 0 | 1, symbol = SYMBOL): DetectedEvent {
  return { type, symbol, hour, t: T0 + hour * H, entry: hour + (type === 'E2' ? 2 : 1), d, atThreshold: false };
}

function naiveQuantile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return quantileSorted(sorted, sorted.length, p);
}

describe('quantileSorted', () => {
  it('is the type 7 percentile', () => {
    const xs = [1, 2, 3, 4, 5];
    expect(quantileSorted(xs, 5, 0.5)).toBe(3);
    expect(quantileSorted(xs, 5, 0.25)).toBe(2);
    expect(quantileSorted(xs, 5, 0.1)).toBeCloseTo(1.4, 12);
    expect(quantileSorted(xs, 5, 0.99)).toBeCloseTo(4.96, 12);
    expect(quantileSorted(xs, 5, 0)).toBe(1);
    expect(quantileSorted(xs, 5, 1)).toBe(5);
    expect(quantileSorted([], 0, 0.5)).toBeNaN();
  });

  it('returns a tied order statistic exactly, so a rate equal to its threshold is a tie', () => {
    expect(quantileSorted(new Array<number>(541).fill(1e-4), 541, 0.99)).toBe(1e-4);
    expect(quantileSorted([0.1, 0.1, 0.2], 3, 0.25)).toBe(0.1);
  });

  it('medianOf averages the two middle values', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('SortedWindow', () => {
  it('matches a sorted array through random inserts and removes', () => {
    const rng = createSeededRandom(3);
    const window = new SortedWindow(200);
    const live: number[] = [];
    for (let i = 0; i < 1_000; i++) {
      if (live.length > 0 && (live.length >= 200 || rng() < 0.4)) {
        const k = Math.floor(rng() * live.length);
        window.remove(live[k]);
        live.splice(k, 1);
      } else {
        const x = Math.round(rng() * 50) / 10; // ties on purpose
        window.insert(x);
        live.push(x);
      }
      expect(window.size).toBe(live.length);
      if (live.length > 0) expect(window.quantile(0.3)).toBe(naiveQuantile(live, 0.3));
    }
  });

  it('refuses a value it does not hold and an insert past capacity', () => {
    const window = new SortedWindow(1);
    window.insert(1);
    expect(() => window.insert(2)).toThrow(/capacity/);
    expect(() => window.remove(3)).toThrow(/not in the window/);
  });
});

describe('buildHourlyPanel', () => {
  it('marks absent and zero-volume hours missing and takes the bar return log(close / open)', () => {
    const panel = panelFrom([{ o: 100, c: 101, v: 5 }, null, { o: 100, c: 101, v: 0 }, { o: 50, c: 49, v: 2 }]);
    expect(Array.from(panel.valid)).toEqual([1, 0, 0, 1]);
    expect(panel.ret[0]).toBeCloseTo(Math.log(1.01), 15);
    expect(panel.ret[1]).toBeNaN();
    expect(panel.ret[2]).toBeNaN();
    expect(panel.volume[2]).toBeNaN();
    expect(panel.absRet[3]).toBeCloseTo(Math.abs(Math.log(49 / 50)), 15);
    expect(Array.from(panel.invalidBefore)).toEqual([0, 0, 1, 2, 2]);
  });

  it('takes the last OI stamped inside the hour, never one from the next hour', () => {
    const bars = [bar(0), bar(0), bar(0), bar(0)];
    const metrics = [
      { t: T0 + 25 * 60_000, openInterest: 1_100 },
      { t: T0 + 55 * 60_000, openInterest: 1_200 }, // last in hour 0, out of order on purpose
      { t: T0, openInterest: 1_000 },
      { t: T0 + H, openInterest: 1_300 },
      { t: T0 + H + 55 * 60_000, openInterest: null }, // no value: hour 1 keeps 1,300
      { t: T0 + 3 * H, openInterest: 1_500 }, // exactly the next hour's open: hour 3
    ];
    const panel = buildHourlyPanel(
      SYMBOL,
      bars.map((b, h) => ({ t: T0 + h * H, ...b })),
      metrics,
      [],
      T0,
      T0 + 4 * H
    );
    expect(Array.from(panel.oi)).toEqual([1_200, 1_300, Number.NaN, 1_500]);
    expect(panel.oiChange[1]).toBeCloseTo(Math.log(1_300 / 1_200), 15);
    expect(panel.oiChange[2]).toBeNaN(); // no OI at 2
    expect(panel.oiChange[3]).toBeNaN(); // no OI at 2, nothing carried across the gap
  });

  it('has no OI change on a missing hour even when both OI readings exist', () => {
    const panel = panelFrom([bar(0), null, bar(0)], { oi: [100, 110, 121] });
    expect(panel.oiChange[1]).toBeNaN();
    expect(panel.oiChange[2]).toBeCloseTo(Math.log(1.1), 15);
  });

  it('reads nothing at or after the grid end and sorts the finite settlements', () => {
    const end = T0 + 2 * H;
    const panel = buildHourlyPanel(
      SYMBOL,
      [
        { t: T0, o: 1, c: 1, v: 1 },
        { t: end, o: 1e9, c: 1e9, v: 1e9 },
      ],
      [{ t: end, openInterest: 5 }],
      [
        { t: T0 + H, rate: 0.002 },
        { t: T0, rate: 0.001 },
        { t: T0 + 30 * 60_000, rate: Number.NaN },
        { t: end, rate: 9 },
      ],
      T0,
      end
    );
    expect(panel.n).toBe(2);
    expect(Array.from(panel.settlementTimes)).toEqual([T0, T0 + H]);
    expect(panel.rateCum[1]).toBe(0.001);
    expect(panel.rateCum[2]).toBeCloseTo(0.003, 15);
    expect(panel.oi.every(Number.isNaN)).toBe(true);
  });

  it('throws on a kline off the hour grid', () => {
    expect(() => buildHourlyPanel(SYMBOL, [{ t: T0 + 1, o: 1, c: 1, v: 1 }], [], [], T0, T0 + H)).toThrow(/hour grid/);
  });
});

describe('trailingQuantiles', () => {
  it('matches a brute-force percentile over the finite values of h - window .. h - 1', () => {
    const rng = createSeededRandom(7);
    const values = Float64Array.from({ length: 400 }, () => (rng() < 0.15 ? Number.NaN : rng() - 0.5));
    const [q02, q98] = trailingQuantiles(values, [0.02, 0.98], 50, 20);
    for (let h = 0; h < values.length; h++) {
      const window = Array.from(values.slice(Math.max(0, h - 50), h)).filter(Number.isFinite);
      if (window.length < 20) {
        expect(q02[h]).toBeNaN();
        expect(q98[h]).toBeNaN();
      } else {
        expect(q02[h]).toBe(naiveQuantile(window, 0.02));
        expect(q98[h]).toBe(naiveQuantile(window, 0.98));
      }
    }
  });

  it('is causal: no value at or after h moves the threshold at h', () => {
    const rng = createSeededRandom(8);
    const values = Float64Array.from({ length: 4_600 }, () => rng());
    const [base, baseMax] = trailingQuantiles(values, [0.99, 1]);
    for (const h0 of [2_000, 3_333, 4_400]) {
      const perturbed = values.slice();
      for (let k = h0; k < perturbed.length; k++) perturbed[k] = 1e9 * (1 + rng());
      const [after, afterMax] = trailingQuantiles(perturbed, [0.99, 1]);
      for (let h = 0; h <= h0; h++) {
        expect(Object.is(after[h], base[h])).toBe(true);
        expect(Object.is(afterMax[h], baseMax[h])).toBe(true);
      }
      expect(afterMax[h0 + 1]).toBeGreaterThan(1e9); // the first hour whose window holds h0 does move
      expect(baseMax[h0 + 1]).toBeLessThan(1);
    }
  });

  it('spans exactly 4,320 hours: the value at h - 4,320 is in, h - 4,321 is out', () => {
    const values = new Float64Array(4_500);
    values[100] = 1;
    const [max] = trailingQuantiles(values, [1], TRAILING_HOURS, 10);
    expect(max[100]).toBe(0); // its own hour is never inside
    expect(max[101]).toBe(1);
    expect(max[100 + 4_320]).toBe(1);
    expect(max[100 + 4_321]).toBe(0);
  });

  it('needs 2,000 non-missing hours in the window', () => {
    const values = new Float64Array(2_100).fill(1);
    let [q] = trailingQuantiles(values, [0.5]);
    expect(MIN_TRAILING_HOURS).toBe(2_000);
    expect(q[1_999]).toBeNaN();
    expect(q[2_000]).toBe(1);
    values[10] = Number.NaN; // a missing hour breaks no threshold, it just does not count
    [q] = trailingQuantiles(values, [0.5]);
    expect(q[2_000]).toBeNaN();
    expect(q[2_001]).toBe(1);
  });
});

describe('settlementQuantiles', () => {
  it('matches a brute-force percentile over the rates stamped in [t - 180 days, t)', () => {
    const rng = createSeededRandom(9);
    const times: number[] = [];
    const rates: number[] = [];
    let t = T0;
    for (let j = 0; j < 1_200; j++) {
      times.push(t);
      rates.push(rng() < 0.3 ? 1e-4 : (rng() - 0.4) * 1e-3);
      t += (j > 600 && j < 800 ? 4 : 8) * H;
    }
    const [low, high] = settlementQuantiles(times, rates, [0.01, 0.99]);
    for (let j = 0; j < times.length; j++) {
      const window = rates.filter((_, i) => times[i] >= times[j] - 180 * DAY_MS && times[i] < times[j]);
      if (window.length < 300) {
        expect(high[j]).toBeNaN();
      } else {
        expect(low[j]).toBe(naiveQuantile(window, 0.01));
        expect(high[j]).toBe(naiveQuantile(window, 0.99));
      }
    }
  });

  it('includes a settlement exactly 180 days back and excludes one at the same instant', () => {
    expect(settlementQuantiles([0, 180 * DAY_MS], [5, 7], [0.5], 180 * DAY_MS, 1)[0][1]).toBe(5);
    expect(settlementQuantiles([0, 180 * DAY_MS + 1], [5, 7], [0.5], 180 * DAY_MS, 1)[0][1]).toBeNaN();
    expect(settlementQuantiles([5, 5], [1, 2], [0.5], 180 * DAY_MS, 1)[0][1]).toBeNaN();
  });

  it('needs 300 earlier settlements in the window', () => {
    const times = Array.from({ length: 302 }, (_, j) => j * 8 * H);
    const rates = times.map(() => 1e-4);
    const [q] = settlementQuantiles(times, rates, [0.99]);
    expect(q[299]).toBeNaN();
    expect(q[300]).toBe(1e-4);
  });
});

/** 2,300 noisy hours with seeded volume, return and OI; the caller plants events on top. */
function noisyBars(seed: number, n = 2_300): { bars: (Bar | null)[]; oi: number[] } {
  const rng = createSeededRandom(seed);
  const bars: (Bar | null)[] = [];
  const oi: number[] = [];
  let level = 1_000_000;
  for (let h = 0; h < n; h++) {
    bars.push(bar((rng() - 0.5) * 0.004, 1_000 + 500 * rng()));
    level *= 1 + (rng() - 0.5) * 0.002;
    oi.push(level);
  }
  return { bars, oi };
}

describe('event detection', () => {
  const sample = { sampleStart: T0 + 2_150 * H, sampleEnd: T0 + 2_300 * H };

  it('E3: a volume at or above the trailing 99th percentile, entry h + 1, d = sign of the hour', () => {
    const { bars } = noisyBars(21);
    bars[2_120] = bar(0.01, 9_000); // before the sample: not reported
    bars[2_200] = bar(0.01, 9_000);
    bars[2_250] = bar(-0.01, 9_000);
    bars[2_280] = null; // a missing hour is not an event hour
    const panel = panelFrom(bars);
    const [vol99] = trailingQuantiles(panel.volume, [0.99]);
    const events = detectE3(panel, vol99, sample);
    const at = (h: number) => events.find((e) => e.hour === h);
    expect(at(2_200)).toMatchObject({ type: 'E3', entry: 2_201, d: 1, t: T0 + 2_200 * H });
    expect(at(2_250)).toMatchObject({ entry: 2_251, d: -1 });
    expect(at(2_120)).toBeUndefined();
    expect(at(2_280)).toBeUndefined();
    for (const e of events) {
      expect(panel.volume[e.hour]).toBeGreaterThanOrEqual(vol99[e.hour]);
      expect(e.t).toBeGreaterThanOrEqual(sample.sampleStart);
    }
  });

  it('E1: OI change at or below the 2nd percentile AND |return| at or above the 98th', () => {
    const { bars, oi } = noisyBars(22);
    const plant = (h: number, r: number, oiFactor: number) => {
      bars[h] = bar(r, 1_200);
      const factor = oiFactor;
      for (let k = h; k < oi.length; k++) oi[k] *= factor;
    };
    plant(2_200, 0.03, 0.9); // long liquidation up: d = +1
    plant(2_210, -0.03, 0.9); // d = -1
    plant(2_220, 0.03, 1.1); // big move, OI up: not E1
    plant(2_230, 0.0001, 0.9); // OI flush, no move: not E1
    const panel = panelFrom(bars, { oi });
    const [oi02] = trailingQuantiles(panel.oiChange, [0.02]);
    const [abs98] = trailingQuantiles(panel.absRet, [0.98]);
    const events = detectE1(panel, oi02, abs98, sample);
    const hours = events.map((e) => e.hour);
    expect(events.find((e) => e.hour === 2_200)).toMatchObject({ type: 'E1', entry: 2_201, d: 1 });
    expect(events.find((e) => e.hour === 2_210)).toMatchObject({ d: -1 });
    expect(hours).not.toContain(2_220);
    expect(hours).not.toContain(2_230);
    for (const e of events) {
      expect(panel.oiChange[e.hour]).toBeLessThanOrEqual(oi02[e.hour]);
      expect(panel.absRet[e.hour]).toBeGreaterThanOrEqual(abs98[e.hour]);
    }
  });

  it('E2: event hour closes at the settlement, entry at h + 2, crowded longs d = +1', () => {
    const { bars } = noisyBars(23);
    bars[2_223] = null;
    const rng = createSeededRandom(24);
    const funding: { t: number; rate: number }[] = [];
    for (let t = T0 - 200 * DAY_MS; t < T0 + 2_300 * H; t += 8 * H) {
      funding.push({ t, rate: 1e-4 + (rng() - 0.5) * 2e-5 });
    }
    const set = (t: number, rate: number) => {
      const f = funding.find((x) => x.t === t);
      if (!f) throw new Error('no settlement there');
      f.rate = rate;
    };
    set(T0 + 2_208 * H, 0.002);
    set(T0 + 2_216 * H, -0.002);
    set(T0 + 2_224 * H, 0.002); // its event hour (2,223) is missing
    const panel = panelFrom(bars, { funding });
    const [low, high] = settlementQuantiles(panel.settlementTimes, panel.settlementRates, [0.01, 0.99]);
    const events = detectE2(panel, high, low, sample);
    expect(events.find((e) => e.hour === 2_207)).toMatchObject({ type: 'E2', t: T0 + 2_207 * H, entry: 2_209, d: 1 });
    expect(events.find((e) => e.hour === 2_215)).toMatchObject({ entry: 2_217, d: -1 });
    expect(events.find((e) => e.hour === 2_223)).toBeUndefined();
  });

  it('E2 on ties (AMENDMENT 1): a window of equal rates gives nothing, and a base rate tied with the 99th is no event', () => {
    const bars = Array.from({ length: 10 }, () => bar(0));
    const start = T0 + 400 * 8 * H;
    const times = Array.from({ length: 405 }, (_, j) => T0 + j * 8 * H);
    const allEqual = times.map((t) => ({ t, rate: 1e-4 }));
    const panelEqual = panelFrom(bars, { funding: allEqual, start });
    const window = { sampleStart: start, sampleEnd: start + 10 * H };
    const [lo, hi] = settlementQuantiles(panelEqual.settlementTimes, panelEqual.settlementRates, [0.01, 0.99]);
    expect(detectE2(panelEqual, hi, lo, window)).toEqual([]);

    // A few low rates early on: the 1st percentile drops, the 99th stays at the 1e-4 base rate. The base rate is
    // tied with the 99th, not above it, so under the strict rule it marks nothing (it was every settlement before).
    const someLow = times.map((t, j) => ({ t, rate: j < 20 ? -1e-4 : 1e-4 }));
    const panelLow = panelFrom(bars, { funding: someLow, start });
    const [lo2, hi2] = settlementQuantiles(panelLow.settlementTimes, panelLow.settlementRates, [0.01, 0.99]);
    expect(detectE2(panelLow, hi2, lo2, window)).toEqual([]);

    // A rate strictly above a base-rate 99th is a crowded-long event.
    const spike = times.map((t, j) => ({ t, rate: j < 20 ? -1e-4 : j === 401 ? 5e-4 : 1e-4 }));
    const panelSpike = panelFrom(bars, { funding: spike, start });
    const [lo3, hi3] = settlementQuantiles(panelSpike.settlementTimes, panelSpike.settlementRates, [0.01, 0.99]);
    const events = detectE2(panelSpike, hi3, lo3, window);
    expect(events).toHaveLength(1);
    expect(events[0].d).toBe(1);
    expect(events[0].atThreshold).toBe(false);
  });

  it('marks market-wide stress hours: any E1, or E3 on at least three symbols in the same hour', () => {
    const h = (k: number) => T0 + k * H;
    const hours = marketWideStressHours(
      [h(5), h(9)],
      [
        { symbol: 'AUSDT', t: h(1) },
        { symbol: 'BUSDT', t: h(1) },
        { symbol: 'AUSDT', t: h(2) },
        { symbol: 'BUSDT', t: h(2) },
        { symbol: 'CUSDT', t: h(2) },
        { symbol: 'AUSDT', t: h(9) },
        { symbol: 'AUSDT', t: h(3) },
        { symbol: 'AUSDT', t: h(3) },
        { symbol: 'BUSDT', t: h(3) },
      ]
    );
    // h1 has two symbols, h3 two distinct symbols (A twice): neither counts. h2 has three: it does.
    expect(hours).toEqual([h(2), h(5), h(9)]);
  });
});

describe('keepEvents', () => {
  // open of hour h is 100 + h, close is 100 + h + 0.5.
  const ramp = (n: number, missing: number[] = []): (Bar | null)[] =>
    Array.from({ length: n }, (_, h) => (missing.includes(h) ? null : { o: 100 + h, c: 100.5 + h, v: 1 }));

  it('signs the forward return from the entry open to the last close by d', () => {
    const panel = panelFrom(ramp(40));
    const end = T0 + 40 * H;
    const up = keepEvents(panel, [ev('E1', 5, 1)], 4, end).kept[0];
    expect(up.entry).toBe(6);
    expect(up.entryT).toBe(T0 + 6 * H);
    expect(up.signed).toBeCloseTo(Math.log(109.5 / 106), 15);
    const down = keepEvents(panel, [ev('E1', 5, -1)], 4, end).kept[0];
    expect(down.signed).toBeCloseTo(-Math.log(109.5 / 106), 15);
    const e2 = keepEvents(panel, [ev('E2', 5, 1)], 4, end).kept[0];
    expect(e2.entry).toBe(7);
    expect(e2.signed).toBeCloseTo(Math.log(110.5 / 107), 15);
    const one = keepEvents(panel, [ev('E3', 5, 1)], 1, end).kept[0];
    expect(one.signed).toBeCloseTo(Math.log(106.5 / 106), 15);
  });

  it('drops a horizon that crosses a missing hour, and a dropped event blocks nothing', () => {
    const panel = panelFrom(ramp(40, [12]));
    const { kept, drops } = keepEvents(panel, [ev('E1', 10, 1), ev('E1', 11, 1), ev('E1', 13, 1)], 4, T0 + 40 * H);
    // Entry 11 (window 11..14) and entry 12 cross hour 12; entry 14 would sit inside entry 11's window, but
    // entry 11 was never kept.
    expect(kept.map((e) => e.entry)).toEqual([14]);
    expect(drops).toEqual({ noDirection: 0, beyondSample: 0, missing: 2, overlap: 0 });
  });

  it('drops a hold that ends at or after the sample end (note 8)', () => {
    const panel = panelFrom(ramp(40));
    const end = T0 + 40 * H;
    expect(keepEvents(panel, [ev('E1', 34, 1)], 4, end).kept).toHaveLength(1); // ends at hour 38's close
    const late = keepEvents(panel, [ev('E1', 35, 1)], 4, end);
    expect(late.kept).toHaveLength(0);
    expect(late.drops.beyondSample).toBe(1);
  });

  it('de-overlaps greedily per horizon on entry hours', () => {
    const panel = panelFrom(ramp(60));
    const events = [ev('E3', 0, 1), ev('E3', 2, -1), ev('E3', 4, 1), ev('E3', 24, 1)];
    const end = T0 + 60 * H;
    expect(keepEvents(panel, events, 1, end).kept.map((e) => e.entry)).toEqual([1, 3, 5, 25]);
    const at4 = keepEvents(panel, events, 4, end);
    expect(at4.kept.map((e) => e.entry)).toEqual([1, 5, 25]);
    expect(at4.drops.overlap).toBe(1);
    expect(keepEvents(panel, events, 24, end).kept.map((e) => e.entry)).toEqual([1, 25]);
  });

  it('drops an event with no direction and refuses another symbol', () => {
    const panel = panelFrom(ramp(20));
    expect(keepEvents(panel, [ev('E3', 3, 0)], 1, T0 + 20 * H).drops.noDirection).toBe(1);
    expect(() => keepEvents(panel, [ev('E3', 3, 1, 'BBBUSDT')], 1, T0 + 20 * H)).toThrow(/BBBUSDT/);
  });

  it('charges funding in (entry open, hold end], signed by the side s x d, and nets 0.16%', () => {
    expect(ROUND_TRIP_COST).toBeCloseTo(0.0016, 15);
    const funding = [
      { t: T0 + 6 * H, rate: 0.01 }, // at the entry open: excluded
      { t: T0 + 8 * H, rate: 0.0003 },
      { t: T0 + 10 * H, rate: 0.0002 }, // at the hold end: included
      { t: T0 + 11 * H, rate: 0.05 }, // after: excluded
    ];
    const panel = panelFrom(ramp(40), { funding });
    const end = T0 + 40 * H;
    expect(fundingPaid(panel, 1, T0 + 6 * H, T0 + 10 * H)).toBeCloseTo(0.0005, 15);

    const long = keepEvents(panel, [ev('E1', 5, 1)], 4, end).kept[0]; // s +1, d +1: long pays
    expect(long.funding).toBeCloseTo(0.0005, 15);
    expect(long.net).toBeCloseTo(long.signed - 0.0016 - 0.0005, 15);

    const short = keepEvents(panel, [ev('E3', 5, 1)], 4, end).kept[0]; // s -1, d +1: short receives
    expect(short.funding).toBeCloseTo(-0.0005, 15);
    expect(short.net).toBeCloseTo(-short.signed - 0.0016 + 0.0005, 15);

    const fadeShorts = keepEvents(panel, [ev('E2', 4, -1)], 4, end).kept[0]; // s -1, d -1: long from hour 6
    expect(fadeShorts.entry).toBe(6);
    expect(fadeShorts.funding).toBeCloseTo(0.0005, 15);
    expect(fadeShorts.net).toBeCloseTo(-fadeShorts.signed - 0.0016 - 0.0005, 15);
    expect(fadeShorts.net).toBeCloseTo(Math.log(109.5 / 106) - 0.0021, 15);
  });
});

describe('day bootstrap', () => {
  it('the pre-registered settings: 2,000 draws, seed 42, 7-day blocks, a 1,461-day calendar', () => {
    expect(BOOTSTRAP).toEqual({ draws: 2_000, seed: 42, blockDays: 7 });
    const calendar = calendarOf(PREREGISTERED_CONFIG.sampleStart, PREREGISTERED_CONFIG.sampleEnd);
    expect(calendar).toEqual({ start: Date.UTC(2022, 6, 1), nDays: 1_461 });
  });

  it('draws 7 consecutive days per block, wrapping, truncated to the calendar', () => {
    const stub = [0.95, 0.1];
    let i = 0;
    const days = circularBlockDays(() => stub[i++], 10, 7);
    expect(Array.from(days)).toEqual([9, 0, 1, 2, 3, 4, 5, 1, 2, 3]);
  });

  it('is reproducible: the same seed gives the same draws, another seed does not', () => {
    const rng = createSeededRandom(5);
    const days = Array.from({ length: 300 }, () => Math.floor(rng() * 100));
    const values = days.map(() => rng() - 0.5);
    const a = dayBootstrapMeans(days, [values], 100)[0];
    const b = dayBootstrapMeans(days, [values], 100)[0];
    const c = dayBootstrapMeans(days, [values], 100, { ...BOOTSTRAP, seed: 43 })[0];
    expect(a).toHaveLength(2_000);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    const m = dayBootstrapStatistic(days, values, medianOf, 100);
    expect(Array.from(m)).toEqual(Array.from(dayBootstrapStatistic(days, values, medianOf, 100)));
  });

  it('draws every event of a resampled day, across symbols, as one unit', () => {
    // Day 0 holds +1 and -1 (two symbols), every other day is empty: a draw's mean is 0 or undefined.
    const draws = dayBootstrapMeans([0, 0], [[1, -1]], 30, { ...BOOTSTRAP, draws: 200 })[0];
    for (const d of draws) expect(Number.isNaN(d) || d === 0).toBe(true);
    expect(Array.from(draws).some(Number.isNaN)).toBe(true);
  });

  it('p = (1 + draws with |b - observed| >= |observed|) / (draws + 1), empty draws counted', () => {
    const s = summariseDraws(1, Float64Array.from([0, 1, 2, 3, Number.NaN]));
    expect(s.p).toBeCloseTo(5 / 6, 15);
    expect(s.emptyDraws).toBe(1);
    expect(s.ciLow).toBeCloseTo(0.075, 12);
    expect(s.ciHigh).toBeCloseTo(2.925, 12);
    expect(summariseDraws(0, Float64Array.from([0.1, -0.1])).p).toBe(1);
  });

  it('gives the gross and net CIs from the same draws and the smallest p, 1 / 2,001, to a sure effect', () => {
    const calendar = { start: T0, nDays: 20 };
    const kept: KeptEvent[] = Array.from({ length: 40 }, (_, i) => ({
      type: 'E1',
      symbol: SYMBOL,
      horizon: 1,
      hour: i * 12,
      t: T0 + i * 12 * H,
      entry: i * 12 + 1,
      entryT: T0 + (i * 12 + 1) * H,
      d: 1,
      s: 1,
      signed: 0.01 + (i % 3) * 0.001,
      funding: 0,
      net: 0.01 + (i % 3) * 0.001 - ROUND_TRIP_COST,
    }));
    const stats = cellStatistics(kept, calendar);
    expect(stats.n).toBe(40);
    expect(stats.days).toBe(20);
    expect(stats.gross.p).toBeCloseTo(1 / 2_001, 15);
    expect(stats.net.mean).toBeCloseTo(stats.gross.mean - ROUND_TRIP_COST, 15);
    expect(stats.net.ciLow).toBeCloseTo(stats.gross.ciLow - ROUND_TRIP_COST, 15);
    expect(stats.net.ciHigh).toBeCloseTo(stats.gross.ciHigh - ROUND_TRIP_COST, 15);
  });

  it('reports an empty cell as undefined with p 1', () => {
    const stats = cellStatistics([], { start: T0, nDays: 10 });
    expect(stats.n).toBe(0);
    expect(stats.gross.mean).toBeNaN();
    expect(stats.gross.p).toBe(1);
  });
});

function group(key: string, n: number, grossMean: number, agrees: boolean): GroupMean {
  return { key, n, grossMean, agrees };
}

describe('gates', () => {
  const symbols = (agreeing: number) =>
    Array.from({ length: 10 }, (_, i) => group(`S${i}`, 50, 0.01, i < agreeing));
  const periods = (agreeing: number) => Array.from({ length: 4 }, (_, i) => group(`P${i}`, 50, 0.01, i < agreeing));
  const passing = {
    p: 0.0005,
    byRejected: true,
    netCiLow: 1e-6,
    symbols: symbols(6),
    periods: periods(3),
    n: 100,
    days: 60,
  };
  const pass = (overrides: Partial<typeof passing>) =>
    evaluateGates({ ...passing, ...overrides }).map((g) => g.pass);

  it('passes all five exactly at their boundaries', () => {
    const gates = evaluateGates(passing);
    expect(gates.map((g) => g.name)).toEqual(['significance', 'pays', 'breadth', 'time', 'sample']);
    expect(gates.every((g) => g.pass)).toBe(true);
  });

  it('fails each gate one step past its boundary', () => {
    expect(pass({ byRejected: false })).toEqual([false, true, true, true, true]);
    expect(pass({ netCiLow: 0 })).toEqual([true, false, true, true, true]);
    expect(pass({ netCiLow: Number.NaN })).toEqual([true, false, true, true, true]);
    expect(pass({ symbols: symbols(5) })).toEqual([true, true, false, true, true]);
    expect(pass({ periods: periods(2) })).toEqual([true, true, true, false, true]);
    expect(pass({ n: 99 })).toEqual([true, true, true, true, false]);
    expect(pass({ days: 59 })).toEqual([true, true, true, true, false]);
  });

  const keptOf = (symbol: string, entryT: number, signed: number): KeptEvent => ({
    type: 'E3',
    symbol,
    horizon: 1,
    hour: 0,
    t: entryT - H,
    entry: 1,
    entryT,
    d: 1,
    s: -1,
    signed,
    funding: 0,
    net: -signed - ROUND_TRIP_COST,
  });

  it('breadth: a symbol needs 10 kept events and the sign of s; an absent symbol disagrees', () => {
    const kept = [
      ...Array.from({ length: 10 }, () => keptOf('AAAUSDT', T0, -0.01)),
      ...Array.from({ length: 9 }, () => keptOf('BBBUSDT', T0, -0.01)),
      ...Array.from({ length: 10 }, () => keptOf('CCCUSDT', T0, 0.01)),
    ];
    const read = symbolAgreement(kept, ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT'], -1);
    expect(read.map((g) => g.agrees)).toEqual([true, false, false, false]);
    expect(read[3].n).toBe(0);
  });

  it('time: periods by entry time; an empty period or a zero mean disagrees', () => {
    const periodsDef = [
      { label: 'A', from: T0, to: T0 + DAY_MS },
      { label: 'B', from: T0 + DAY_MS, to: T0 + 2 * DAY_MS },
      { label: 'C', from: T0 + 2 * DAY_MS, to: T0 + 3 * DAY_MS },
      { label: 'D', from: T0 + 3 * DAY_MS, to: T0 + 4 * DAY_MS },
    ];
    const kept = [
      keptOf(SYMBOL, T0 + H, 0.02),
      keptOf(SYMBOL, T0 + DAY_MS + H, 0.01),
      keptOf(SYMBOL, T0 + DAY_MS + 2 * H, -0.01),
      keptOf(SYMBOL, T0 + 3 * DAY_MS - 1, -0.001),
    ];
    expect(periodAgreement(kept, periodsDef, 1).map((g) => g.agrees)).toEqual([true, false, false, false]);
    expect(periodAgreement(kept, periodsDef, -1).map((g) => g.agrees)).toEqual([false, false, true, false]);
  });
});

describe('reportedBlock', () => {
  const at = (symbol: string, dayOffset: number, signed: number, funding: number, year = 2024): KeptEvent => {
    const entryT = Date.UTC(year, 0, 1) + dayOffset * DAY_MS + H;
    return {
      type: 'E1',
      symbol,
      horizon: 1,
      hour: 0,
      t: entryT - H,
      entry: 1,
      entryT,
      d: 1,
      s: 1,
      signed,
      funding,
      net: signed - ROUND_TRIP_COST - funding,
    };
  };

  it('counts, doubles the cost, takes the median, the hit rate and the 10 largest days', () => {
    const kept = [
      at('AAAUSDT', 0, 0.01, 0, 2023),
      at('AAAUSDT', 0, -0.02, 0.001, 2023),
      at('AAAUSDT', 0, 0.03, 0),
      ...Array.from({ length: 11 }, (_, i) => at('BBBUSDT', i + 1, 0.04, -0.001 / 11)),
    ];
    const block = reportedBlock(kept, 1, ['AAAUSDT', 'BBBUSDT', 'CCCUSDT']);
    expect(block.countsBySymbol).toEqual({ AAAUSDT: 3, BBBUSDT: 11, CCCUSDT: 0 });
    expect(block.countsByYear).toEqual({ '2023': 2, '2024': 12 });
    const expected2x = kept.reduce((s, e) => s + e.signed - 0.0032 - e.funding, 0) / kept.length;
    expect(block.netMeanAt2xCost).toBeCloseTo(expected2x, 15);
    expect(block.medianSigned).toBe(0.04);
    expect(block.hitRate).toBeCloseTo(13 / 14, 15);
    expect(reportedBlock(kept, -1, []).hitRate).toBeCloseTo(1 / 14, 15);
    // 2023-01-01 holds 2 events; 2024-01-01 one; the 11 BBB days one each. The largest 10: 2 + 9 x 1.
    expect(block.top10DayShare).toBeCloseTo(11 / 14, 15);
  });
});

describe('volatility ratio', () => {
  it('is 4 when the next 24 hours run at twice the trailing absolute return', () => {
    const a = 0.004;
    const bars = Array.from({ length: 800 }, (_, h) => bar((h % 2 === 0 ? 1 : -1) * (h >= 760 && h < 784 ? 2 * a : a)));
    const panel = panelFrom(bars);
    const event = keepEvents(panel, [ev('E3', 759, 1)], 24, T0 + 800 * H).kept[0];
    expect(volatilityRatio(panel, event)).toBeCloseTo(4, 10);

    const thin = keepEvents(panel, [ev('E3', 300, 1)], 24, T0 + 800 * H).kept[0]; // 300 trailing hours < 360
    expect(volatilityRatio(panel, thin)).toBeNaN();

    const read = ratioRead([event, thin], () => panel, { start: T0, nDays: 34 });
    expect(read).toMatchObject({ n: 1, excluded: 1 });
    expect(read.median).toBeCloseTo(4, 10);
    expect(read.ciLow).toBeCloseTo(4, 10);
    expect(read.ciHigh).toBeCloseTo(4, 10);
  });
});

describe('stress flag', () => {
  // 300 days: every 10th day runs at 5% an hour, the rest at a slowly falling 1%, so a day is in its trailing
  // 180-day top quintile exactly when it is a 10th day.
  const days = 300;
  const bars: (Bar | null)[] = [];
  for (let day = 0; day < days; day++) {
    const level = day % 10 === 0 ? 0.05 : 0.01 * (1 - day / 1_000);
    for (let hour = 0; hour < 24; hour++) bars.push(bar((hour % 2 === 0 ? 1 : -1) * level));
  }
  const btc = panelFrom(bars, { symbol: 'BTCUSDT' });
  const D = (day: number) => T0 + day * DAY_MS;

  it('realised variance needs all 24 hours', () => {
    expect(dailyRealisedVariance(btc, D(5))).toBeCloseTo(24 * (0.01 * 0.995) ** 2, 12);
    const holed = panelFrom([...bars.slice(0, 30), null, ...bars.slice(31, 48)]);
    expect(dailyRealisedVariance(holed, D(1))).toBeNaN();
  });

  it('scores the flag by balanced accuracy on a planted series', () => {
    const opens = [
      D(250) - 3 * H, // flags 250 (top): TP
      D(260) - 24 * H, // first hour whose close is inside 260's window: TP
      D(270) - H, // closes exactly at 270: TP
      ...Array.from({ length: 9 }, (_, i) => D(251 + i) - 12 * H), // 251..259 (not top): FP
      D(280), // closes an hour into 280, so it flags 281 (FP) and not 280 (FN)
      D(290) - 25 * H, // closes 24h before 290: flags 289 (FP), 290 is FN
    ];
    const read = evaluateStressFlag(opens, btc, D(250), D(300));
    expect(read).toMatchObject({ days: 50, skippedDays: 0, topQuintileDays: 5, flaggedDays: 14 });
    expect(read).toMatchObject({ tp: 3, fn: 2, fp: 11, tn: 34 });
    expect(read.hitRate).toBeCloseTo(0.6, 15);
    expect(read.trueNegativeRate).toBeCloseTo(34 / 45, 15);
    expect(read.balancedAccuracy).toBeCloseTo((0.6 + 34 / 45) / 2, 15);
  });

  it('skips a day with fewer than 90 trailing days and leaves the score undefined with an empty class', () => {
    const read = evaluateStressFlag([], btc, D(80), D(100));
    expect(read.skippedDays).toBe(10);
    expect(read.days).toBe(10);
    expect(read.tp + read.fp).toBe(0);
    expect(read.hitRate).toBe(0);
    const none = evaluateStressFlag([], btc, D(251), D(260)); // no top day at all
    expect(none.topQuintileDays).toBe(0);
    expect(none.balancedAccuracy).toBeNaN();
  });
});

// The end-to-end run: ten synthetic symbols, a 120-day sample after 100 days of history.
const S = Date.UTC(2025, 0, 1);
const TEST_CONFIG: EventStudyConfig = {
  symbols: EVENT_SYMBOLS,
  sampleStart: S,
  sampleEnd: S + 120 * DAY_MS,
  periods: [0, 30, 60, 90].map((d, i) => ({ label: `P${i + 1}`, from: S + d * DAY_MS, to: S + (d + 30) * DAY_MS })),
  stressFrom: S + 30 * DAY_MS,
  stressTo: S + 120 * DAY_MS,
};
const PLANT = {
  from: S,
  to: S + 120 * DAY_MS,
  everyDays: 4,
  hourOfDay: 12,
  move: 0.01,
  reversal: 0.015,
  spikeVolume: 20_000,
};

function panelsOf(data: SyntheticSymbol[], config = TEST_CONFIG): HourlyPanel[] {
  return data.map((d) => buildHourlyPanel(d.symbol, d.klines, d.metrics, d.funding, gridStartOf(config), config.sampleEnd));
}

function asReport(result: EventStudyResult): EventStudyReport {
  return {
    schemaVersion: 1,
    taskId: 'synthetic',
    datasetManifestHash: 'f'.repeat(64),
    lockboxApplied: true,
    ...result,
    computedAt: '2026-10-08T00:00:00.000Z',
    gitCommit: 'test',
    durationMs: 1,
  };
}

describe('runEventStudies, end to end on synthetic panels', () => {
  let planted: SyntheticSymbol[];
  let plantedResult: EventStudyResult;
  let nullResult: EventStudyResult;

  beforeAll(() => {
    planted = syntheticDataset(EVENT_SYMBOLS, { from: S - 100 * DAY_MS, to: S + 120 * DAY_MS, seed: 11, plantE3: PLANT });
    plantedResult = runEventStudies(panelsOf(planted), TEST_CONFIG);
    const plain = syntheticDataset(EVENT_SYMBOLS, { from: S - 100 * DAY_MS, to: S + 120 * DAY_MS, seed: 11 });
    nullResult = runEventStudies(panelsOf(plain), TEST_CONFIG);
  }, 60_000);

  it('runs the nine cells in the pre-registered order with the fixed sides', () => {
    expect(plantedResult.cells.map((c) => `${c.event}-${c.horizon}h:${c.side}`)).toEqual([
      'E1-1h:1',
      'E1-4h:1',
      'E1-24h:1',
      'E2-1h:-1',
      'E2-4h:-1',
      'E2-24h:-1',
      'E3-1h:-1',
      'E3-4h:-1',
      'E3-24h:-1',
    ]);
    expect(plantedResult.trials).toBe(9);
    expect(plantedResult.ledgerAfter).toBe(1_741);
    expect(plantedResult.e1Sensitivity.map((c) => c.horizon)).toEqual([1, 4, 24]);
  });

  it('passes the planted volume-shock reversal at 1h through all five gates', () => {
    const cell = plantedResult.cells.find((c) => c.event === 'E3' && c.horizon === 1)!;
    expect(cell.n).toBeGreaterThanOrEqual(300);
    expect(cell.gross.mean!).toBeLessThan(0); // the move reversed
    expect(cell.net.ciLow!).toBeGreaterThan(0);
    expect(cell.gates.every((g) => g.pass)).toBe(true);
    expect(cell.pass).toBe(true);
    expect(cell.symbols.every((s) => s.agrees)).toBe(true);
    expect(plantedResult.passingCells).toContain('E3-1h');
    expect(plantedResult.verdict).toBe('provisional-pass');
  });

  it('passes no cell on pure noise', () => {
    expect(nullResult.passingCells).toEqual([]);
    expect(nullResult.verdict).toBe('no-cell-passes');
    expect(plantedResult.cells.filter((c) => c.event !== 'E3').some((c) => c.pass)).toBe(false);
  });

  it('applies Benjamini-Yekutieli across exactly the nine gross p-values', () => {
    for (const result of [plantedResult, nullResult]) {
      const expected = benjaminiYekutieli(
        result.cells.map((c) => c.gross.p),
        0.1
      );
      expect(result.cells.map((c) => c.byRejected)).toEqual(expected);
      expect(result.cells.map((c) => c.gates[0].pass)).toEqual(expected);
    }
  });

  it('reads volatility after the planted shocks and scores the stress flag', () => {
    const v = plantedResult.volatility;
    expect(v.byEvent.E3.n).toBeGreaterThan(0);
    expect(v.byEvent.E3.median!).toBeGreaterThan(1);
    expect(v.pooledE1E3.n).toBeGreaterThanOrEqual(v.byEvent.E3.n);
    expect(v.stress).not.toBeNull();
    expect(v.stress!.days + v.stress!.skippedDays).toBe(90);
    expect(v.stress!.balancedAccuracy!).toBeGreaterThanOrEqual(0);
    expect(v.stress!.balancedAccuracy!).toBeLessThanOrEqual(1);
    expect(v.product.pass).toBe(v.product.balancedAccuracyPass && v.product.ratioPass);
  });

  it('is deterministic: a second run is identical', () => {
    expect(runEventStudies(panelsOf(planted), TEST_CONFIG)).toEqual(plantedResult);
  }, 30_000);

  it('reads nothing at or after the sample end', () => {
    const end = TEST_CONFIG.sampleEnd;
    const poisoned = planted.map((d) => ({
      ...d,
      klines: [...d.klines, { t: end, o: 1e6, h: 1e6, l: 1, c: 1, v: 1e12, qv: 1, n: 1, tbv: null }],
      metrics: [...d.metrics, { ...d.metrics[0], t: end, openInterest: 1 }],
      funding: [...d.funding, { t: end, rate: 5, intervalHours: 8 }],
    }));
    expect(runEventStudies(panelsOf(poisoned), TEST_CONFIG)).toEqual(plantedResult);
  }, 30_000);

  it('round-trips through the report schema, which strips nothing it declares', () => {
    const report = asReport(plantedResult);
    const validated = validateEventStudyReport(report);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.data).toEqual(report);
    const reparsed = validateEventStudyReport(JSON.parse(JSON.stringify(report)));
    expect(reparsed.ok && reparsed.data).toEqual(report);
    expect(validateEventStudyReport(asReport(nullResult)).ok).toBe(true);
  });

  it('rejects a report missing a field or carrying NaN', () => {
    const report = asReport(plantedResult) as Record<string, unknown>;
    const withoutCells = { ...report };
    delete withoutCells.cells;
    expect(validateEventStudyReport(withoutCells).ok).toBe(false);
    const nan = JSON.parse(JSON.stringify(report));
    nan.cells[0].gross.p = Number.NaN;
    expect(validateEventStudyReport(nan).ok).toBe(false);
  });
});
