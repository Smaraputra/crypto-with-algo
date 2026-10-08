import { describe, it, expect } from 'vitest';
import { compareFlow, parseArgs, MIN_BUCKETS, PASS_FRACTION } from './validate-agg-flow';

const mk = (n: number, buy = 100, sell = 50) =>
  Array.from({ length: n }, (_, i) => ({ bucketStart: i * 300_000, buyQuote: buy, sellQuote: sell }));

describe('compareFlow', () => {
  it('passes when every bucket agrees within 0.5%', () => {
    const r = compareFlow(mk(20), mk(20, 100.4, 50.2));
    expect(r).toMatchObject({ bucketsCompared: 20, bucketsWithin: 20, passFraction: 1, pass: true });
  });

  it('requires BOTH sides within 0.5%', () => {
    const r = compareFlow(mk(20), mk(20, 100, 51));
    expect(r.bucketsWithin).toBe(0);
    expect(r.pass).toBe(false);
  });

  it('passes at exactly 95% and fails just under', () => {
    const rec = mk(20);
    const bad = (k: number) => mk(20).map((b, i) => (i < k ? { ...b, buyQuote: 120 } : b));
    expect(compareFlow(bad(1), rec).pass).toBe(true);
    expect(compareFlow(bad(1), rec).passFraction).toBe(0.95);
    expect(compareFlow(bad(2), rec).pass).toBe(false);
  });

  it('fails with too few buckets even when all agree', () => {
    const r = compareFlow(mk(MIN_BUCKETS - 1), mk(MIN_BUCKETS - 1));
    expect(r).toMatchObject({ passFraction: 1, pass: false });
    expect(compareFlow(mk(MIN_BUCKETS), mk(MIN_BUCKETS)).pass).toBe(true);
    expect(PASS_FRACTION).toBe(0.95);
  });

  it('compares only buckets present on both sides', () => {
    const r = compareFlow(mk(30), mk(20).map((b) => ({ ...b, bucketStart: b.bucketStart + 10 * 300_000 })));
    expect(r.bucketsCompared).toBe(20);
  });

  it('reports up to 5 worst buckets with both values, worst first', () => {
    const arch = mk(20).map((b, i) => (i < 7 ? { ...b, buyQuote: 100 + (i + 1) * 10 } : b));
    const r = compareFlow(arch, mk(20));
    expect(r.worst).toHaveLength(5);
    expect(r.worst[0]).toMatchObject({ bucketStart: 6 * 300_000, archiveBuy: 170, recorderBuy: 100 });
    expect(r.worst[0]).toHaveProperty('archiveSell');
    expect(r.worst[0]).toHaveProperty('recorderSell');
  });

  it('treats a zero recorder side as equal only when the archive is also zero', () => {
    expect(compareFlow(mk(12, 0, 0), mk(12, 0, 0)).pass).toBe(true);
    expect(compareFlow(mk(12, 1, 0), mk(12, 0, 0)).bucketsWithin).toBe(0);
  });

  it('handles no overlap', () => {
    expect(compareFlow([], mk(20))).toMatchObject({ bucketsCompared: 0, passFraction: 0, pass: false });
  });
});

describe('parseArgs', () => {
  it('parses flags', () => {
    expect(parseArgs(['--symbol', 'BTCUSDT', '--date', '2026-10-08', '--mongo-uri', 'mongodb://x'])).toEqual({
      symbol: 'BTCUSDT',
      date: '2026-10-08',
      mongoUri: 'mongodb://x',
    });
  });
  it('requires symbol and a valid date', () => {
    expect(() => parseArgs(['--date', '2026-10-08'])).toThrow(/--symbol/);
    expect(() => parseArgs(['--symbol', 'BTCUSDT', '--date', '2026-10'])).toThrow(/YYYY-MM-DD/);
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown flag/);
  });
});
