import { describe, it, expect } from 'vitest';
import {
  naiveFold,
  compareDay,
  parseArgs,
  DEFAULT_DATES,
  type NaiveBucket,
  type StoredBar,
} from './check-agg-flow-naive';

const B0 = Date.UTC(2024, 0, 15, 0, 0, 0);
const B1 = B0 + 300_000;

const CSV = [
  'agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker',
  // bucket 0: taker sold, quote 9999.99 (small), 3 fills, inside open 10s (9999 ms)
  `1,99.9999,100,10,12,${B0 + 9_999},true`,
  // bucket 0: taker bought, quote exactly 10000 (medium), outside open 10s (10000 ms), 1 fill
  `2,100,100,13,13,${B0 + 10_000},false`,
  // bucket 0: taker bought, quote 99999 (medium), 2 fills
  `3,99999,1,14,15,${B0 + 20_000},false`,
  // bucket 0: taker sold, quote exactly 100000 (large), at bucket start (inside open)
  `4,1000,100,16,16,${B0},true`,
  // bucket 1: taker bought, large, inside open
  `5,50000,3,17,19,${B1 + 5_000},false`,
  // bucket 1: taker sold, small, outside open
  `6,10,5,20,20,${B1 + 299_999},true`,
].join('\n');

function fold(csv: string): Map<number, NaiveBucket> {
  return naiveFold(csv.split('\n'));
}

describe('naiveFold', () => {
  const buckets = fold(CSV);
  const b0 = buckets.get(B0) as NaiveBucket;
  const b1 = buckets.get(B1) as NaiveBucket;

  it('skips the header and splits into two buckets', () => {
    expect([...buckets.keys()].sort()).toEqual([B0, B1]);
  });

  it('maps is_buyer_maker true to taker sell and false to taker buy', () => {
    expect(b0.sellBase).toBeCloseTo(200, 9);
    expect(b0.buyBase).toBeCloseTo(101, 9);
    expect(b1.buyBase).toBe(3);
    expect(b1.sellBase).toBe(5);
    expect(b0.sellQuote).toBeCloseTo(99.9999 * 100 + 100000, 6);
    expect(b0.buyQuote).toBeCloseTo(10000 + 99999, 6);
  });

  it('puts exactly 10000 in medium and exactly 100000 in large', () => {
    expect(b0.buyQuoteSmall).toBe(0);
    expect(b0.buyQuoteMedium).toBeCloseTo(10000 + 99999, 6);
    expect(b0.buyQuoteLarge).toBe(0);
    expect(b0.sellQuoteSmall).toBeCloseTo(99.9999 * 100, 6);
    expect(b0.sellQuoteMedium).toBe(0);
    expect(b0.sellQuoteLarge).toBe(100000);
    expect(b1.buyQuoteLarge).toBe(150000);
    expect(b1.sellQuoteSmall).toBe(50);
  });

  it('counts the open 10s window as [start, start + 10000)', () => {
    expect(b0.sellQuoteOpen10s).toBeCloseTo(99.9999 * 100 + 100000, 6);
    expect(b0.buyQuoteOpen10s).toBe(0);
    expect(b1.buyQuoteOpen10s).toBe(150000);
    expect(b1.sellQuoteOpen10s).toBe(0);
  });

  it('sums fills as last - first + 1 and counts rows', () => {
    expect(b0.trades).toBe(3 + 1 + 2 + 1);
    expect(b0.aggTrades).toBe(4);
    expect(b1.trades).toBe(3 + 1);
    expect(b1.aggTrades).toBe(2);
  });

  it('keeps an out-of-order row in its own bucket', () => {
    const csv = [
      `1,10,1,1,1,${B1 + 1},false`,
      `2,10,1,2,2,${B0 + 1},false`,
    ];
    const m = naiveFold(csv);
    expect(m.get(B0)?.aggTrades).toBe(1);
    expect(m.get(B1)?.aggTrades).toBe(1);
  });

  it('throws on a malformed row', () => {
    expect(() => naiveFold(['1,10,1,1,1'])).toThrow(/Malformed/);
    expect(() => naiveFold([`1,x,1,1,1,${B0},true`])).toThrow(/Malformed/);
    expect(() => naiveFold([`1,10,1,1,1,${B0},maybe`])).toThrow(/Malformed/);
  });
});

function stored(from: NaiveBucket): StoredBar {
  return { ...from };
}

describe('compareDay', () => {
  const naive = fold(CSV);
  const storedAll = (): StoredBar[] => [...naive.values()].map(stored);

  it('passes when identical', () => {
    const r = compareDay(naive, storedAll());
    expect(r.pass).toBe(true);
    expect(r.naiveBuckets).toBe(2);
    expect(r.storedBuckets).toBe(2);
    expect(r.worstRelErr).toBe(0);
    expect(r.countMismatches).toBe(0);
  });

  it('fails a 1e-8 relative drift and names the field', () => {
    const s = storedAll();
    const idx = s.findIndex((x) => x.bucketStart === B1);
    s[idx] = { ...s[idx], buyQuoteLarge: s[idx].buyQuoteLarge * (1 + 1e-8) };
    const r = compareDay(naive, s);
    expect(r.pass).toBe(false);
    expect(r.worstField).toBe('buyQuoteLarge');
    expect(r.worstRelErr).toBeGreaterThan(1e-9);
  });

  it('passes a drift below 1e-9', () => {
    const s = storedAll();
    s[0] = { ...s[0], buyBase: s[0].buyBase * (1 + 1e-11) };
    expect(compareDay(naive, s).pass).toBe(true);
  });

  it('fails a bucket missing in stored', () => {
    const r = compareDay(naive, storedAll().slice(0, 1));
    expect(r.pass).toBe(false);
    expect(r.missingInStored).toBe(1);
    expect(r.missingInNaive).toBe(0);
  });

  it('fails a bucket missing in naive', () => {
    const extra: StoredBar = { ...stored(naive.get(B0) as NaiveBucket), bucketStart: B1 + 300_000 };
    const r = compareDay(naive, [...storedAll(), extra]);
    expect(r.pass).toBe(false);
    expect(r.missingInNaive).toBe(1);
  });

  it('fails an aggTrades count off by one', () => {
    const s = storedAll();
    s[1] = { ...s[1], aggTrades: s[1].aggTrades - 1 };
    const r = compareDay(naive, s);
    expect(r.pass).toBe(false);
    expect(r.countMismatches).toBe(1);
  });

  it('fails a count off by one', () => {
    const s = storedAll();
    s[0] = { ...s[0], trades: s[0].trades + 1 };
    const r = compareDay(naive, s);
    expect(r.pass).toBe(false);
    expect(r.countMismatches).toBe(1);
  });

  it('fails when stored has an undefined numeric field', () => {
    const s = storedAll();
    s[0] = { ...s[0], sellBase: undefined as unknown as number };
    expect(compareDay(naive, s).pass).toBe(false);
  });
});

describe('parseArgs', () => {
  it('defaults to 10 symbols x 8 days = 80 samples', () => {
    const a = parseArgs([]);
    expect(a.symbols).toHaveLength(10);
    expect(a.dates).toEqual([...DEFAULT_DATES]);
    expect(a.dates).toHaveLength(8);
    expect(a.symbols.length * a.dates.length).toBe(80);
    expect(a.mongoUri).toBeNull();
  });

  it('accepts overrides', () => {
    const a = parseArgs(['--symbols', 'BTCUSDT, ETHUSDT', '--dates', '2024-03-01', '--mongo-uri', 'mongodb://x']);
    expect(a.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(a.dates).toEqual(['2024-03-01']);
    expect(a.mongoUri).toBe('mongodb://x');
  });

  it('refuses lockbox dates', () => {
    expect(() => parseArgs(['--dates', '2026-07-01'])).toThrow(/lockbox/);
    expect(() => parseArgs(['--dates', '2024-01-01,2026-08-15'])).toThrow(/lockbox/);
  });

  it('allows the last day before the lockbox', () => {
    expect(parseArgs(['--dates', '2026-06-30']).dates).toEqual(['2026-06-30']);
  });

  it('rejects bad dates and unknown flags', () => {
    expect(() => parseArgs(['--dates', '2024-1-5'])).toThrow(/YYYY-MM-DD/);
    expect(() => parseArgs(['--dates', '2024-02-30'])).toThrow(/YYYY-MM-DD/);
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown flag/);
    expect(() => parseArgs(['--symbols'])).toThrow(/needs a value/);
  });
});
