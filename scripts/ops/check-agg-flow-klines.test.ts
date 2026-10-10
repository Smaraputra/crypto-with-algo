import { describe, it, expect } from 'vitest';
import {
  compareBucket,
  checkInvariants,
  createAccumulator,
  addMonth,
  finalize,
  parseArgs,
  type ArchiveBar,
  type KlineBar,
} from './check-agg-flow-klines';

const T0 = Date.UTC(2024, 0, 1);
const STEP = 300_000;

function archive(i: number, over: Partial<ArchiveBar> = {}): ArchiveBar {
  return {
    bucketStart: T0 + i * STEP,
    trades: 100,
    buyBase: 6,
    sellBase: 4,
    buyQuote: 600,
    sellQuote: 400,
    buyQuoteSmall: 100,
    buyQuoteMedium: 200,
    buyQuoteLarge: 300,
    sellQuoteSmall: 100,
    sellQuoteMedium: 100,
    sellQuoteLarge: 200,
    buyQuoteOpen10s: 10,
    sellQuoteOpen10s: 5,
    ...over,
  };
}

function kline(i: number, over: Partial<KlineBar> = {}): KlineBar {
  return {
    timestamp: T0 + i * STEP,
    volume: 10,
    quoteVolume: 1000,
    trades: 100,
    takerBuyVolume: 6,
    ...over,
  };
}

describe('compareBucket', () => {
  it('gives zeros on an exact match', () => {
    const r = compareBucket(archive(0), kline(0));
    expect(r).toEqual({ volume: 0, quoteVolume: 0, takerBuy: 0, tradesMatch: true });
  });

  it('reports a 1e-7 relative drift', () => {
    const r = compareBucket(archive(0, { buyBase: 6, sellBase: 4 }), kline(0, { volume: 10 * (1 + 1e-7) }));
    expect(r.volume).toBeGreaterThan(9e-8);
    expect(r.volume).toBeLessThanOrEqual(1e-6);
  });

  it('flags trades off by one', () => {
    expect(compareBucket(archive(0), kline(0, { trades: 101 })).tradesMatch).toBe(false);
  });

  it('gives takerBuy null when the kline lacks takerBuyVolume', () => {
    expect(compareBucket(archive(0), kline(0, { takerBuyVolume: undefined })).takerBuy).toBeNull();
  });
});

describe('checkInvariants', () => {
  it('passes a consistent bucket', () => {
    expect(checkInvariants(archive(0))).toEqual([]);
  });

  it('fails a class sum off by 1e-6 relative', () => {
    expect(checkInvariants(archive(0, { buyQuoteLarge: 300 + 600e-6 })).length).toBeGreaterThan(0);
  });

  it('accepts a class sum within 1e-9 relative', () => {
    expect(checkInvariants(archive(0, { buyQuoteLarge: 300 + 600e-11 }))).toEqual([]);
  });

  it('uses an absolute tolerance when the total is 0', () => {
    const zero = archive(0, {
      buyQuote: 0, buyQuoteSmall: 0, buyQuoteMedium: 0, buyQuoteLarge: 0, buyQuoteOpen10s: 0,
    });
    expect(checkInvariants(zero)).toEqual([]);
    expect(checkInvariants({ ...zero, buyQuoteSmall: 1e-6 }).length).toBeGreaterThan(0);
  });

  it('fails open10s above the total', () => {
    expect(checkInvariants(archive(0, { buyQuoteOpen10s: 601 })).length).toBeGreaterThan(0);
    expect(checkInvariants(archive(0, { sellQuoteOpen10s: 401 })).length).toBeGreaterThan(0);
  });

  it('fails NaN and negative values', () => {
    expect(checkInvariants(archive(0, { buyBase: Number.NaN })).length).toBeGreaterThan(0);
    expect(checkInvariants(archive(0, { sellBase: -1 })).length).toBeGreaterThan(0);
  });
});

describe('accumulator', () => {
  it('counts a traded kline without an archive bucket as missingInArchive', () => {
    const acc = createAccumulator('BTCUSDT');
    addMonth(acc, [], [kline(0)]);
    const r = finalize(acc);
    expect(r.missingInArchive).toBe(1);
    expect(r.zeroTradeKlines).toBe(0);
    expect(r.klineBuckets).toBe(1);
    expect(r.pass).toBe(false);
  });

  it('counts a zero-trade kline without an archive bucket only in zeroTradeKlines', () => {
    const acc = createAccumulator('BTCUSDT');
    addMonth(acc, [archive(1)], [kline(0, { trades: 0, volume: 0, quoteVolume: 0, takerBuyVolume: 0 }), kline(1)]);
    const r = finalize(acc);
    expect(r.zeroTradeKlines).toBe(1);
    expect(r.missingInArchive).toBe(0);
    expect(r.missingInKlines).toBe(0);
    expect(r.compared).toBe(1);
    expect(r.pass).toBe(true);
  });

  it('counts an archive bucket without a kline as missingInKlines', () => {
    const acc = createAccumulator('BTCUSDT');
    addMonth(acc, [archive(0), archive(1)], [kline(0)]);
    const r = finalize(acc);
    expect(r.missingInKlines).toBe(1);
    expect(r.archiveBuckets).toBe(2);
    expect(r.pass).toBe(false);
  });

  it('bands errors and orders the worst five', () => {
    const acc = createAccumulator('BTCUSDT');
    const a: ArchiveBar[] = [];
    const k: KlineBar[] = [];
    const drifts = [0, 1e-10, 1e-7, 1e-4, 0.01, 0.02, 0.03, 0.04, 0.05];
    drifts.forEach((d, i) => {
      a.push(archive(i));
      k.push(kline(i, { volume: 10 * (1 + d) }));
    });
    addMonth(acc, a, k);
    const r = finalize(acc);
    expect(r.volume.bands).toEqual({ exact: 1, le1e9: 1, le1e6: 1, le1e3: 1, gt1e3: 5 });
    expect(r.volume.worst).toHaveLength(5);
    const errs = r.volume.worst.map((w) => w.relErr);
    expect([...errs].sort((x, y) => y - x)).toEqual(errs);
    expect(r.volume.worst[0].bucketStart).toBe(new Date(T0 + 8 * STEP).toISOString());
    expect(r.quoteVolume.bands.exact).toBe(9);
  });

  it('counts takerBuyUnavailable and excludes them from takerBuy bands', () => {
    const acc = createAccumulator('BTCUSDT');
    addMonth(acc, [archive(0), archive(1)], [kline(0, { takerBuyVolume: undefined }), kline(1)]);
    const r = finalize(acc);
    expect(r.takerBuyUnavailable).toBe(1);
    expect(r.takerBuy.bands.exact).toBe(1);
    expect(r.pass).toBe(true);
  });

  it('records trades mismatches with the worst five', () => {
    const acc = createAccumulator('BTCUSDT');
    const a: ArchiveBar[] = [];
    const k: KlineBar[] = [];
    for (let i = 0; i < 7; i++) {
      a.push(archive(i));
      k.push(kline(i, { trades: 100 + (i + 1) }));
    }
    addMonth(acc, a, k);
    const r = finalize(acc);
    expect(r.tradesMismatch.count).toBe(7);
    expect(r.tradesMismatch.worst).toHaveLength(5);
  });

  it('records invariant failures with the first five', () => {
    const acc = createAccumulator('BTCUSDT');
    const a: ArchiveBar[] = [];
    const k: KlineBar[] = [];
    for (let i = 0; i < 7; i++) {
      a.push(archive(i, { buyQuoteOpen10s: 9999 }));
      k.push(kline(i));
    }
    addMonth(acc, a, k);
    const r = finalize(acc);
    expect(r.invariantFailures.count).toBe(7);
    expect(r.invariantFailures.first).toHaveLength(5);
    expect(r.invariantFailures.first[0].bucketStart).toBe(new Date(T0).toISOString());
    expect(r.pass).toBe(false);
  });

  function thousand(badCount: number) {
    const acc = createAccumulator('BTCUSDT');
    const a: ArchiveBar[] = [];
    const k: KlineBar[] = [];
    for (let i = 0; i < 1000; i++) {
      a.push(archive(i));
      k.push(kline(i, i < badCount ? { volume: 11 } : {}));
    }
    addMonth(acc, a, k);
    return finalize(acc);
  }

  it('passes with 1 of 1000 out of tolerance (99.9%)', () => {
    expect(thousand(1).pass).toBe(true);
  });

  it('fails with 2 of 1000 out of tolerance', () => {
    expect(thousand(2).pass).toBe(false);
  });

  it('fails when nothing was compared', () => {
    expect(finalize(createAccumulator('BTCUSDT')).pass).toBe(false);
  });

  it('accumulates across months', () => {
    const acc = createAccumulator('BTCUSDT');
    addMonth(acc, [archive(0)], [kline(0)]);
    addMonth(acc, [archive(1)], [kline(1)]);
    expect(finalize(acc).compared).toBe(2);
  });
});

describe('parseArgs', () => {
  it('applies defaults', () => {
    const a = parseArgs([]);
    expect(a.from).toBe('2023-01');
    expect(a.to).toBe('2026-06');
    expect(a.mongoUri).toBeNull();
    expect(a.symbols.length).toBeGreaterThan(0);
  });

  it('parses flags', () => {
    const a = parseArgs(['--symbols', 'BTCUSDT,ETHUSDT', '--from', '2024-01', '--to', '2024-03', '--mongo-uri', 'mongodb://x']);
    expect(a).toEqual({ symbols: ['BTCUSDT', 'ETHUSDT'], from: '2024-01', to: '2024-03', mongoUri: 'mongodb://x' });
  });

  it('refuses the lockbox', () => {
    expect(() => parseArgs(['--to', '2026-07'])).toThrow(/lockbox/i);
    expect(() => parseArgs(['--to', '2027-01'])).toThrow(/lockbox/i);
  });

  it('rejects a bad month format', () => {
    expect(() => parseArgs(['--from', '2024-1'])).toThrow(/YYYY-MM/);
    expect(() => parseArgs(['--to', '2024-13'])).toThrow(/YYYY-MM/);
  });

  it('rejects from after to and unknown flags', () => {
    expect(() => parseArgs(['--from', '2024-05', '--to', '2024-04'])).toThrow();
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown flag/);
  });
});
