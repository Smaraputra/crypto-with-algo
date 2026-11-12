// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COST_FIELDS,
  buildUniverse,
  main,
  marketsHash,
  median,
  parseArgs,
  parseOrderBooks,
  parseSnapshotText,
  selectUniverse,
  toCostRow,
  type CostRow,
} from './lighter-universe';

const orderBooksJson = {
  code: 200,
  order_books: [
    { symbol: 'ETH', market_id: 0, market_type: 'perp', status: 'active', supported_price_decimals: 2, supported_size_decimals: 4, min_quote_amount: '10.000000' },
    { symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', supported_price_decimals: 1, supported_size_decimals: 5 },
    { symbol: 'SOL', market_id: 2, market_type: 'perp', status: 'active', supported_price_decimals: 3, supported_size_decimals: 3 },
    { symbol: 'OLD', market_id: 3, market_type: 'perp', status: 'inactive', supported_price_decimals: 2, supported_size_decimals: 2 },
    { symbol: 'ETH/USDC', market_id: 4, market_type: 'spot', status: 'active', supported_price_decimals: 2, supported_size_decimals: 2 },
  ],
};

const books = parseOrderBooks(orderBooksJson);

interface RunSpec {
  runs: number;
  buy: number | null;
  sell: number | null;
  oi?: number | null;
  startTs?: number;
}

function lighterRows(coin: string, symbol: string, spec: RunSpec): CostRow[] {
  const out: CostRow[] = [];
  const start = spec.startTs ?? 1_000_000;
  for (let i = 0; i < spec.runs; i++) {
    out.push({
      ts: start + i,
      venue: 'lighter',
      coin,
      symbol,
      oiUsd: spec.oi === undefined ? 5_000_000 : spec.oi,
      buySlipBps: spec.buy,
      sellSlipBps: spec.sell,
    });
  }
  return out;
}

function binanceRows(coin: string, symbol: string, count: number, startTs = 1_000_000): CostRow[] {
  const out: CostRow[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ ts: startTs + i, venue: 'binance', coin, symbol, oiUsd: 1, buySlipBps: 0.1, sellSlipBps: 0.1 });
  }
  return out;
}

describe('parseOrderBooks', () => {
  it('keeps only active perp markets with their decimals', () => {
    expect([...books.keys()].sort()).toEqual(['BTC', 'ETH', 'SOL']);
    expect(books.get('ETH')).toEqual({ symbol: 'ETH', marketId: 0, priceDecimals: 2, sizeDecimals: 4 });
  });
});

describe('median', () => {
  it('handles odd, even and unsorted input', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([7])).toBe(7);
  });
});

describe('selectUniverse rule clauses', () => {
  it('rejects a symbol without an active perp order book entry', () => {
    const rows = [...lighterRows('OLD', 'OLD', { runs: 5, buy: 0.1, sell: 0.1 }), ...lighterRows('ETHSPOT', 'ETH/USDC', { runs: 5, buy: 0.1, sell: 0.1 }), ...lighterRows('XYZ', 'XYZ', { runs: 5, buy: 0.1, sell: 0.1 })];
    expect(selectUniverse(rows, books, 5)).toEqual([]);
  });

  it('ignores non-lighter rows as candidates', () => {
    const rows = lighterRows('ETH', 'ETH', { runs: 5, buy: 0.1, sell: 0.1 }).map((r) => ({ ...r, venue: 'bybit' }));
    expect(selectUniverse(rows, books, 5)).toEqual([]);
  });

  it('applies the min-runs cut on distinct priced runs', () => {
    const rows = lighterRows('ETH', 'ETH', { runs: 10, buy: 0.2, sell: 0.2 });
    expect(selectUniverse(rows, books, 10)).toHaveLength(1);
    expect(selectUniverse(rows, books, 11)).toHaveLength(0);
  });

  it('counts a repeated ts once', () => {
    const rows = lighterRows('ETH', 'ETH', { runs: 6, buy: 0.2, sell: 0.2 });
    const doubled = [...rows, ...rows];
    expect(selectUniverse(doubled, books, 7)).toHaveLength(0);
    expect(selectUniverse(doubled, books, 6)[0].runs).toBe(6);
  });

  it('does not count runs with null slippage, on either side', () => {
    const good = lighterRows('ETH', 'ETH', { runs: 4, buy: 0.2, sell: 0.2 });
    const nullBuy = lighterRows('ETH', 'ETH', { runs: 4, buy: null, sell: 0.2, startTs: 2_000_000 });
    const nullSell = lighterRows('ETH', 'ETH', { runs: 4, buy: 0.2, sell: null, startTs: 3_000_000 });
    const rows = [...good, ...nullBuy, ...nullSell];
    expect(selectUniverse(rows, books, 5)).toHaveLength(0);
    const result = selectUniverse(rows, books, 4);
    expect(result).toHaveLength(1);
    expect(result[0].runs).toBe(4);
  });

  it('keeps roundTrip exactly at 2.5 and drops anything above', () => {
    const at = lighterRows('ETH', 'ETH', { runs: 3, buy: 1.25, sell: 1.25 });
    const above = lighterRows('BTC', 'BTC', { runs: 3, buy: 1.25, sell: 1.2501 });
    const result = selectUniverse([...at, ...above], books, 3);
    expect(result.map((m) => m.coin)).toEqual(['ETH']);
    expect(result[0].roundTripBps).toBe(2.5);
  });

  it('uses the median, so a few outlier runs do not decide', () => {
    const rows = lighterRows('ETH', 'ETH', { runs: 5, buy: 0.5, sell: 0.5 });
    rows[0].buySlipBps = 90;
    rows[1].sellSlipBps = 90;
    const result = selectUniverse(rows, books, 5);
    expect(result).toHaveLength(1);
    expect(result[0].roundTripBps).toBe(1);
  });

  it('assigns tier A at exactly 1.0 and tier B just above', () => {
    const a = lighterRows('ETH', 'ETH', { runs: 3, buy: 0.5, sell: 0.5 });
    const b = lighterRows('BTC', 'BTC', { runs: 3, buy: 0.5, sell: 0.5001 });
    const result = selectUniverse([...a, ...b], books, 3);
    expect(result.find((m) => m.coin === 'ETH')?.tier).toBe('A');
    expect(result.find((m) => m.coin === 'BTC')?.tier).toBe('B');
  });

  it('keeps median oiUsd at exactly 2,000,000 and drops below', () => {
    const at = lighterRows('ETH', 'ETH', { runs: 3, buy: 0.2, sell: 0.2, oi: 2_000_000 });
    const below = lighterRows('BTC', 'BTC', { runs: 3, buy: 0.2, sell: 0.2, oi: 1_999_999 });
    expect(selectUniverse([...at, ...below], books, 3).map((m) => m.coin)).toEqual(['ETH']);
  });

  it('takes the oi median over runs that have one, and fails with none', () => {
    const rows = lighterRows('ETH', 'ETH', { runs: 5, buy: 0.2, sell: 0.2, oi: 3_000_000 });
    rows[0].oiUsd = null;
    rows[1].oiUsd = null;
    const result = selectUniverse(rows, books, 5);
    expect(result).toHaveLength(1);
    expect(result[0].medianOiUsd).toBe(3_000_000);

    const none = lighterRows('BTC', 'BTC', { runs: 5, buy: 0.2, sell: 0.2, oi: null });
    expect(selectUniverse(none, books, 5)).toEqual([]);
  });

  it('maps binanceSymbol only with binance rows in at least half of the priced runs', () => {
    const eth = lighterRows('ETH', 'ETH', { runs: 10, buy: 0.2, sell: 0.2 });
    const btc = lighterRows('BTC', 'BTC', { runs: 10, buy: 0.2, sell: 0.2 });
    const sol = lighterRows('SOL', 'SOL', { runs: 10, buy: 0.2, sell: 0.2 });
    const rows = [
      ...eth,
      ...btc,
      ...sol,
      ...binanceRows('ETH', 'ETHUSDT', 5), // exactly half
      ...binanceRows('BTC', 'BTCUSDT', 4), // below half
    ];
    const result = selectUniverse(rows, books, 10);
    expect(result.find((m) => m.coin === 'ETH')?.binanceSymbol).toBe('ETHUSDT');
    expect(result.find((m) => m.coin === 'BTC')?.binanceSymbol).toBeNull();
    expect(result.find((m) => m.coin === 'SOL')?.binanceSymbol).toBeNull();
  });

  it('counts binance coverage only on the priced lighter runs', () => {
    const eth = lighterRows('ETH', 'ETH', { runs: 10, buy: 0.2, sell: 0.2 });
    // Binance rows exist on 10 other runs, none on the priced ones.
    const rows = [...eth, ...binanceRows('ETH', 'ETHUSDT', 10, 9_000_000)];
    expect(selectUniverse(rows, books, 10)[0].binanceSymbol).toBeNull();
  });

  it('takes the most frequent binance symbol, ties alphabetical', () => {
    const eth = lighterRows('ETH', 'ETH', { runs: 6, buy: 0.2, sell: 0.2 });
    const first = binanceRows('ETH', 'ETHUSDT', 3);
    const second = binanceRows('ETH', 'ETHBUSD', 3, 1_000_003);
    expect(selectUniverse([...eth, ...first, ...second], books, 6)[0].binanceSymbol).toBe('ETHBUSD');
  });

  it('sorts by roundTripBps then coin and carries market metadata', () => {
    const rows = [
      ...lighterRows('SOL', 'SOL', { runs: 3, buy: 0.5, sell: 0.5 }),
      ...lighterRows('BTC', 'BTC', { runs: 3, buy: 0.5, sell: 0.5 }),
      ...lighterRows('ETH', 'ETH', { runs: 3, buy: 0.1, sell: 0.1 }),
    ];
    const result = selectUniverse(rows, books, 3);
    expect(result.map((m) => m.coin)).toEqual(['ETH', 'BTC', 'SOL']);
    expect(result[0]).toMatchObject({
      coin: 'ETH',
      lighterMarketId: 0,
      lighterSymbol: 'ETH',
      priceDecimals: 2,
      sizeDecimals: 4,
      runs: 3,
      tier: 'A',
    });
  });
});

describe('determinism', () => {
  it('gives byte-identical output for shuffled row order and a repeated build', () => {
    const rows = [
      ...lighterRows('ETH', 'ETH', { runs: 8, buy: 0.3, sell: 0.4 }),
      ...lighterRows('BTC', 'BTC', { runs: 8, buy: 0.1, sell: 0.2 }),
      ...binanceRows('ETH', 'ETHUSDT', 8),
    ];
    const shuffled = [...rows].reverse();
    const a = buildUniverse([{ rows, runTimestamps: rows.map((r) => r.ts) }], ['a.jsonl'], books, 8);
    const b = buildUniverse([{ rows: shuffled, runTimestamps: shuffled.map((r) => r.ts) }], ['a.jsonl'], books, 8);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(marketsHash(a.markets)).toBe(marketsHash(b.markets));
    expect(marketsHash(a.markets)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('cost-only guard', () => {
  it('pins the list of fields the module may read', () => {
    expect([...COST_FIELDS]).toEqual(['ts', 'venue', 'coin', 'symbol', 'oiUsd', 'buySlipBps', 'sellSlipBps']);
  });

  it('toCostRow drops every field outside the list', () => {
    const row = toCostRow({
      ts: 1,
      venue: 'lighter',
      coin: 'ETH',
      symbol: 'ETH',
      fundingRate: 0.01,
      mark: 100,
      index: 101,
      bid: 99,
      ask: 101,
      spreadBps: 5,
      oiUsd: 3,
      buySlipBps: 0.2,
      sellSlipBps: 0.3,
    });
    expect(row).not.toBeNull();
    expect(Object.keys(row!).sort()).toEqual([...COST_FIELDS].sort());
  });

  it('selectUniverse works on rows that carry ONLY the allowed fields', () => {
    const rows: CostRow[] = lighterRows('ETH', 'ETH', { runs: 4, buy: 0.2, sell: 0.2 }).map((r) => ({
      ts: r.ts,
      venue: r.venue,
      coin: r.coin,
      symbol: r.symbol,
      oiUsd: r.oiUsd,
      buySlipBps: r.buySlipBps,
      sellSlipBps: r.sellSlipBps,
    }));
    expect(Object.keys(rows[0]).sort()).toEqual([...COST_FIELDS].sort());
    expect(selectUniverse(rows, books, 4)).toHaveLength(1);
  });

  it('selectUniverse touches no property outside the allowed fields', () => {
    const allowed = new Set<string>(COST_FIELDS);
    const touched: string[] = [];
    const rows = lighterRows('ETH', 'ETH', { runs: 4, buy: 0.2, sell: 0.2 }).map(
      (r) =>
        new Proxy(r, {
          get(target, prop, receiver) {
            if (typeof prop === 'string' && !allowed.has(prop)) touched.push(prop);
            return Reflect.get(target, prop, receiver);
          },
        })
    );
    expect(selectUniverse(rows, books, 4)).toHaveLength(1);
    expect(touched).toEqual([]);
  });

  it('the module source never accesses a price or return field', () => {
    const source = readFileSync(join(__dirname, 'lighter-universe.ts'), 'utf8');
    expect(source).not.toMatch(/\.(mark|fundingRate|bid|ask|spreadBps|nextFundingTime|fundingIntervalHours)\b/);
  });

  it('results do not change when price fields are altered in the raw lines', () => {
    const base = { ts: 5, venue: 'lighter', coin: 'ETH', symbol: 'ETH', oiUsd: 4_000_000, buySlipBps: 0.2, sellSlipBps: 0.2 };
    const lineA = JSON.stringify({ ...base, mark: 100, index: 100, fundingRate: 0.001, bid: 99, ask: 101 });
    const lineB = JSON.stringify({ ...base, mark: 7, index: 9, fundingRate: -0.5, bid: 1, ask: 2 });
    const a = parseSnapshotText(lineA);
    const b = parseSnapshotText(lineB);
    expect(a).toEqual(b);
  });
});

describe('parseSnapshotText', () => {
  it('skips manifest lines and blank lines but counts their ts as runs', () => {
    const text = [
      JSON.stringify({ manifest: true, ts: 10, venues: ['lighter'] }),
      JSON.stringify({ ts: 10, venue: 'lighter', coin: 'ETH', symbol: 'ETH', oiUsd: 1, buySlipBps: null, sellSlipBps: 0.3 }),
      '',
      JSON.stringify({ ts: 20, venue: 'lighter', coin: 'ETH', symbol: 'ETH', oiUsd: 1, buySlipBps: 0.1, sellSlipBps: 0.3 }),
    ].join('\n');
    const parsed = parseSnapshotText(text);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].buySlipBps).toBeNull();
    expect(new Set(parsed.runTimestamps)).toEqual(new Set([10, 20]));
  });

  it('throws on a malformed line and names the file and line', () => {
    expect(() => parseSnapshotText('{"ts":1}\n{oops', 'x.jsonl')).toThrow(/x\.jsonl: line 2/);
  });
});

describe('buildUniverse generatedFrom', () => {
  it('reports distinct runs, first and last ts and file names', () => {
    const rows = lighterRows('ETH', 'ETH', { runs: 3, buy: 0.2, sell: 0.2, startTs: 100 });
    const out = buildUniverse([{ rows, runTimestamps: [100, 101, 102] }], ['2026-11-10.jsonl'], books, 3);
    expect(out.generatedFrom).toEqual({ runs: 3, firstTs: 100, lastTs: 102, files: ['2026-11-10.jsonl'] });
    expect(out.rule).toMatchObject({ minRuns: 3, maxRoundTripBps: 2.5, tierARoundTripBps: 1, minMedianOiUsd: 2_000_000 });
  });
});

describe('parseArgs', () => {
  it('requires the three paths and defaults min-runs to 150', () => {
    expect(parseArgs(['--snapshots-dir', 'd', '--order-books', 'o.json', '--out', 'u.json'])).toEqual({
      snapshotsDir: 'd',
      orderBooks: 'o.json',
      out: 'u.json',
      minRuns: 150,
    });
    expect(() => parseArgs(['--snapshots-dir', 'd', '--out', 'u.json'])).toThrow(/--order-books is required/);
    expect(() => parseArgs(['--snapshots-dir', 'd', '--order-books', 'o', '--out', 'u', '--min-runs', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--bogus', 'x'])).toThrow(/Unknown flag/);
  });
});

describe('main', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('writes a deterministic file and prints the markets hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lighter-universe-'));
    dirs.push(dir);
    const snaps = join(dir, 'snaps');
    const lines: string[] = [];
    for (let i = 0; i < 4; i++) {
      const ts = 1_000 + i;
      lines.push(JSON.stringify({ manifest: true, ts }));
      lines.push(JSON.stringify({ ts, venue: 'lighter', coin: 'ETH', symbol: 'ETH', oiUsd: 5_000_000, buySlipBps: 0.3, sellSlipBps: 0.4, mark: 1 }));
      lines.push(JSON.stringify({ ts, venue: 'binance', coin: 'ETH', symbol: 'ETHUSDT', oiUsd: 9_000_000, buySlipBps: 0.1, sellSlipBps: 0.1 }));
    }
    mkdirSync(snaps);
    writeFileSync(join(snaps, '2026-11-10.jsonl'), lines.join('\n') + '\n');
    writeFileSync(join(snaps, 'ignore.txt'), 'not read');
    const ob = join(dir, 'ob.json');
    writeFileSync(ob, JSON.stringify(orderBooksJson));
    const out1 = join(dir, 'u1.json');
    const out2 = join(dir, 'u2.json');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(main(['--snapshots-dir', snaps, '--order-books', ob, '--out', out1, '--min-runs', '4'])).toBe(0);
    expect(main(['--snapshots-dir', snaps, '--order-books', ob, '--out', out2, '--min-runs', '4'])).toBe(0);

    expect(readFileSync(out1)).toEqual(readFileSync(out2));
    const parsed = JSON.parse(readFileSync(out1, 'utf8'));
    expect(parsed.markets).toHaveLength(1);
    expect(parsed.markets[0]).toMatchObject({ coin: 'ETH', binanceSymbol: 'ETHUSDT', tier: 'A', runs: 4 });
    expect(parsed.markets[0].roundTripBps).toBeCloseTo(0.7, 9);
    expect(parsed.generatedFrom).toEqual({ runs: 4, firstTs: 1000, lastTs: 1003, files: ['2026-11-10.jsonl'] });
    const printed = log.mock.calls.map((c) => String(c[0]));
    expect(printed.some((l) => l === `markets sha256 ${marketsHash(parsed.markets)}`)).toBe(true);
  });
});
