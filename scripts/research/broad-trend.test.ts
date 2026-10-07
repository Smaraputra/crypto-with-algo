// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { PerpCandleRow } from './dataset-format';
import {
  DAY_MS,
  basketMembership,
  buildMembership,
  contractEnded,
  dayStartMs,
  eligibleAt,
  monthCloses,
  rankAt,
  rankingVolume,
  segmentContracts,
  tradedDays,
  universeFile,
  type Contract,
} from './broad-trend';

/** n consecutive daily bars from `start`, with per-bar overrides. */
function bars(
  start: string,
  n: number,
  opts: { c?: number | ((i: number) => number); qv?: number | ((i: number) => number); v?: number } = {}
): PerpCandleRow[] {
  const t0 = dayStartMs(start);
  return Array.from({ length: n }, (_, i) => {
    const c = typeof opts.c === 'function' ? opts.c(i) : (opts.c ?? 100);
    const qv = typeof opts.qv === 'function' ? opts.qv(i) : (opts.qv ?? 1_000_000);
    return { t: t0 + i * DAY_MS, o: c, h: c, l: c, c, v: opts.v ?? 10, qv, n: 100, tbv: null };
  });
}

function one(symbol: string, rows: PerpCandleRow[]): Contract {
  const contracts = segmentContracts(symbol, rows);
  expect(contracts).toHaveLength(1);
  return contracts[0];
}

describe('tradedDays', () => {
  it('drops zero-volume bars and keeps one bar per day, ascending', () => {
    const rows = [...bars('2021-01-03', 1), ...bars('2021-01-01', 2), ...bars('2021-01-04', 1, { v: 0 })];
    expect(tradedDays(rows).map((r) => r.t)).toEqual([0, 1, 2].map((i) => dayStartMs('2021-01-01') + i * DAY_MS));
  });
});

describe('segmentContracts', () => {
  it('keeps a continuous series as one contract with the asset key', () => {
    const [c] = segmentContracts('1000SHIBUSDT', bars('2021-01-01', 10));
    expect(c.id).toBe('1000SHIBUSDT#1');
    expect(c.assetKey).toBe('SHIB');
    expect(c.bars).toHaveLength(10);
  });

  it('ends a contract after more than 7 missing days, and not after exactly 7', () => {
    const eight = segmentContracts('AUSDT', [...bars('2021-01-01', 5), ...bars('2021-01-14', 5)]);
    expect(eight.map((c) => c.id)).toEqual(['AUSDT#1', 'AUSDT#2']);
    const seven = segmentContracts('AUSDT', [...bars('2021-01-01', 5), ...bars('2021-01-13', 5)]);
    expect(seven).toHaveLength(1);
  });

  it('counts zero-volume bars as missing days', () => {
    const rows = [...bars('2021-01-01', 5), ...bars('2021-01-06', 8, { v: 0 }), ...bars('2021-01-14', 5)];
    expect(segmentContracts('CVXUSDT', rows)).toHaveLength(2);
  });

  it('splits a short gap only across a jump beyond 5x or under one fifth', () => {
    const up = segmentContracts('BUSDT', [...bars('2021-01-01', 5, { c: 1 }), ...bars('2021-01-09', 5, { c: 6 })]);
    expect(up).toHaveLength(2);
    const down = segmentContracts('BUSDT', [...bars('2021-01-01', 5, { c: 10 }), ...bars('2021-01-09', 5, { c: 1.9 })]);
    expect(down).toHaveLength(2);
    const four = segmentContracts('BUSDT', [...bars('2021-01-01', 5, { c: 1 }), ...bars('2021-01-09', 5, { c: 4 })]);
    expect(four).toHaveLength(1);
  });

  it('never splits consecutive traded days, however large the move (a crash is booked)', () => {
    const crash = bars('2022-05-01', 10, { c: (i) => (i < 5 ? 80 : 0.0001) });
    expect(segmentContracts('LUNAUSDT', crash)).toHaveLength(1);
  });
});

describe('contractEnded', () => {
  it('is the last traded day before 2026-06-30, otherwise null', () => {
    expect(contractEnded(one('XUSDT', bars('2026-06-20', 9)))).toBe(dayStartMs('2026-06-28'));
    expect(contractEnded(one('XUSDT', bars('2026-06-20', 11)))).toBeNull();
  });

  it('gives the earlier contract of a split ticker an end', () => {
    const [first, second] = segmentContracts('XUSDT', [...bars('2025-01-01', 5), ...bars('2025-02-01', 5)]);
    expect(contractEnded(first)).toBe(dayStartMs('2025-01-05'));
    expect(contractEnded(second)).toBe(dayStartMs('2025-02-05'));
  });
});

describe('eligibleAt', () => {
  const close = dayStartMs('2022-01-01');

  it('needs 366 bars closed by C, not 365', () => {
    // 2021 has 365 days: 365 bars closed by 2022-01-01, one short of the default 366
    expect(eligibleAt(one('XUSDT', bars('2021-01-01', 365)), close)).toBe(false);
    expect(eligibleAt(one('XUSDT', bars('2021-01-01', 365)), close, 365)).toBe(true);
    expect(eligibleAt(one('XUSDT', bars('2020-12-31', 366)), close, 366)).toBe(true);
  });

  it('needs a traded bar closing at C', () => {
    expect(eligibleAt(one('XUSDT', bars('2020-12-01', 395)), close, 366)).toBe(false); // last bar 2021-12-30
  });

  it('ignores bars closing after C and zero-volume bars in the count', () => {
    const rows = [...bars('2020-12-31', 366), ...bars('2022-01-01', 30)];
    expect(eligibleAt(one('XUSDT', rows), close, 366)).toBe(true);
    const withHalt = [...bars('2020-12-31', 2), ...bars('2021-01-02', 3, { v: 0 }), ...bars('2021-01-05', 361)];
    // 2 + 361 traded bars: one short of 366 once the halted days are dropped
    expect(segmentContracts('XUSDT', withHalt)).toHaveLength(1);
    expect(eligibleAt(segmentContracts('XUSDT', withHalt)[0], close, 366)).toBe(false);
  });

  it('restarts the age of a relisted ticker', () => {
    const rows = [...bars('2020-01-01', 500), ...bars('2021-06-01', 214)]; // gap of 7+ days, relisted to 2021-12-31
    const [, relisted] = segmentContracts('XUSDT', rows);
    expect(relisted.id).toBe('XUSDT#2');
    expect(eligibleAt(relisted, close, 366)).toBe(false);
  });
});

describe('rankingVolume', () => {
  const close = dayStartMs('2022-01-01');

  it('is the median quote volume of the 30 days closing by C', () => {
    const c = one('XUSDT', bars('2021-11-01', 61, { qv: (i) => i }));
    // bars closing by C are i = 0..60; the window keeps t >= C - 30 days: i = 31..60, median 45.5
    expect(rankingVolume(c, close)).toBe(45.5);
  });

  it('needs at least 20 bars in the window', () => {
    // window is 2021-12-02..2021-12-31: 7 bars (Dec 2-8), 7 missing days, 12 bars (Dec 16-27) = 19
    const rows = [...bars('2021-11-01', 38), ...bars('2021-12-16', 12)];
    expect(rankingVolume(one('XUSDT', rows), close)).toBeNull();
    const twenty = [...bars('2021-11-01', 38), ...bars('2021-12-16', 13)];
    expect(rankingVolume(one('XUSDT', twenty), close)).toBe(1_000_000);
  });
});

describe('rankAt', () => {
  const close = dayStartMs('2022-01-01');
  const opts = { minBars: 366, topN: 50 };

  function contract(symbol: string, qv: number, extraDaysAfterC = 0): Contract {
    return one(symbol, bars('2020-12-31', 366 + extraDaysAfterC, { qv }));
  }

  it('ranks by median volume, ties by ticker, and truncates to top N', () => {
    const contracts = [contract('CUSDT', 5), contract('AUSDT', 9), contract('BUSDT', 9), contract('DUSDT', 1)];
    const ranked = rankAt(contracts, close, { minBars: 366, topN: 3 });
    expect(ranked.map((r) => [r.symbol, r.rank])).toEqual([
      ['AUSDT', 1],
      ['BUSDT', 2],
      ['CUSDT', 3],
    ]);
  });

  it('ranks only the higher-volume contract of an asset, the first ticker on a tie', () => {
    const higher = rankAt([contract('1000SHIBUSDT', 5), contract('SHIBUSDT', 7)], close, opts);
    expect(higher.map((r) => r.symbol)).toEqual(['SHIBUSDT']);
    const tie = rankAt([contract('SHIBUSDT', 7), contract('1000SHIBUSDT', 7)], close, opts);
    expect(tie.map((r) => r.symbol)).toEqual(['1000SHIBUSDT']);
  });

  it('reads nothing closing after C', () => {
    const base = [contract('AUSDT', 9, 40), contract('BUSDT', 5, 40)];
    const before = rankAt(base, close, opts);
    const mutated = base.map((c) => ({
      ...c,
      bars: c.bars.map((b) => (b.t + DAY_MS > close ? { ...b, qv: b.qv * 1000, c: b.c * 50 } : b)),
    }));
    expect(rankAt(mutated, close, opts)).toEqual(before);
  });

  it('still selects a contract that delists three days after C', () => {
    const delisting = contract('ZUSDT', 100, 3);
    expect(contractEnded(delisting)).toBe(dayStartMs('2022-01-03'));
    expect(rankAt([delisting, contract('AUSDT', 1)], close, opts)[0].symbol).toBe('ZUSDT');
  });
});

describe('buildMembership', () => {
  it('starts at the first close with enough eligible contracts and runs monthly to the end', () => {
    const contracts = [
      one('AUSDT', bars('2020-01-01', 900)),
      one('BUSDT', bars('2020-02-15', 900)),
      one('CUSDT', bars('2020-03-20', 900)),
    ];
    const m = buildMembership(contracts, { from: '2021-01-01', to: '2021-06-01', minBars: 366, topN: 2, minEligibleToStart: 2 });
    // A eligible from 2021-01-01 (366 bars closed by then), B from 2021-03-01, C from 2021-04-01
    expect(m.eligibleCounts.map((e) => e.eligible)).toEqual([1, 1, 2, 3, 3]);
    expect(m.startClose).toBe('2021-03-01');
    expect(m.startLaterThan20210701).toBe(false);
    expect(m.months.map((x) => [x.close, x.validUntil, x.members.length])).toEqual([
      ['2021-03-01', '2021-04-01', 2],
      ['2021-04-01', '2021-05-01', 2],
      ['2021-05-01', '2021-06-01', 2],
    ]);
  });

  it('flags a start later than 2021-07-01, which fails gate 1 by construction', () => {
    const m = buildMembership([one('AUSDT', bars('2020-09-01', 600))], {
      from: '2021-01-01',
      to: '2022-01-01',
      minBars: 366,
      topN: 50,
      minEligibleToStart: 1,
    });
    // 2020-09-01 + 366 bars closes on 2021-09-02, so the first close with 366 bars is 2021-10-01
    expect(m.startClose).toBe('2021-10-01');
    expect(m.startLaterThan20210701).toBe(true);
  });

  it('gives the C3 basket a 30-bar eligibility from 2020-02-01', () => {
    const basket = basketMembership([one('AUSDT', bars('2020-01-01', 100))], { to: '2020-04-01' });
    expect(basket.months[0].close).toBe('2020-02-01');
    expect(basket.months[0].members.map((x) => x.symbol)).toEqual(['AUSDT']);
  });

  it('lists the first of each month in [from, to)', () => {
    expect(monthCloses('2021-11-01', '2022-02-01').map((ms) => new Date(ms).toISOString().slice(0, 10))).toEqual([
      '2021-11-01',
      '2021-12-01',
      '2022-01-01',
    ]);
  });
});

describe('universeFile', () => {
  const contracts = [one('AUSDT', bars('2020-01-01', 600)), one('BUSDT', bars('2020-01-01', 600, { qv: 5 }))];
  const options = {
    universe: { from: '2021-01-01', to: '2021-04-01', minBars: 366, topN: 50, minEligibleToStart: 1 },
    basket: { from: '2020-02-01', to: '2021-04-01', minBars: 30, topN: 50, minEligibleToStart: 0 },
  };

  it('hashes its content deterministically, whatever the input order', () => {
    const a = universeFile({ sourceDatasetHash: 'abc', contracts, ...options });
    const b = universeFile({ sourceDatasetHash: 'abc', contracts: [...contracts].reverse(), ...options });
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.sha256).toBe(a.sha256);
  });

  it('changes its hash when the source data changes', () => {
    const a = universeFile({ sourceDatasetHash: 'abc', contracts, ...options });
    const c = universeFile({ sourceDatasetHash: 'abd', contracts, ...options });
    expect(c.sha256).not.toBe(a.sha256);
  });

  it('records counts per month for the universe and the basket', () => {
    const file = universeFile({ sourceDatasetHash: 'abc', contracts, ...options });
    expect(file.countsPerMonth[0]).toEqual({
      close: '2021-01-01',
      eligible: 2,
      members: 2,
      basketEligible: 2,
      basketMembers: 2,
    });
  });
});

describe('broad-universe CLI helpers', () => {
  it('parses its two required flags and refuses anything else', async () => {
    const { parseArgs } = await import('./broad-universe');
    expect(parseArgs(['--dataset-dir', '/d', '--out', '/u.json'])).toEqual({ datasetDir: '/d', out: '/u.json' });
    expect(() => parseArgs(['--out', '/u.json'])).toThrow(/--dataset-dir/);
    expect(() => parseArgs(['--dataset-dir', '/d', '--allow-lockbox'])).toThrow(/Unknown flag/);
  });

  it('reads the symbols with a 1d perp klines file only', async () => {
    const { perpDailySymbols } = await import('./broad-universe');
    expect(
      perpDailySymbols([
        { kind: 'perp', interval: '1d', path: 'perp/BUSDT/1d.jsonl.gz', symbol: 'BUSDT' },
        { kind: 'perp', interval: '1d', path: 'perp/AUSDT/1d.jsonl.gz', symbol: 'AUSDT' },
        { kind: 'perp', interval: '1d', path: 'perp/AUSDT/1d.premiumIndex.jsonl.gz', symbol: 'AUSDT' },
        { kind: 'funding', interval: '8h', path: 'funding/AUSDT/settlements.jsonl.gz', symbol: 'AUSDT' },
        { kind: 'perp', interval: '4h', path: 'perp/CUSDT/4h.jsonl.gz', symbol: 'CUSDT' },
      ])
    ).toEqual(['AUSDT', 'BUSDT']);
  });
});
