import { describe, expect, it } from 'vitest';

import { burstBoundary, Sampler, type SamplerSource } from './sampler';
import type { BurstRow, GapReport, QuoteRow, QuoteState, StreamName } from './types';

const B = Date.UTC(2026, 10, 11, 12, 5, 0);

function state(over: Partial<QuoteState> = {}): QuoteState {
  return {
    ok: true,
    exch: 1,
    recv: 2,
    bid: 100,
    ask: 101,
    bidSz: 1,
    askSz: 2,
    rt100: 1,
    rt1000: 2,
    rt5000: 3,
    rt20000: 4,
    ...over,
  };
}

function make(source?: SamplerSource) {
  const rows: Array<{ stream: StreamName; row: QuoteRow | BurstRow }> = [];
  const gaps: GapReport[] = [];
  const sampler = new Sampler({
    coins: { lighter: ['BTC', 'NVDA'], binance: ['BTC'] },
    source: source ?? { quote: () => state() },
    emit: (stream, row) => rows.push({ stream, row }),
    onGap: (g) => gaps.push(g),
  });
  return { sampler, rows, gaps };
}

const of = (rows: ReturnType<typeof make>['rows'], stream: StreamName) => rows.filter((r) => r.stream === stream);

describe('burstBoundary', () => {
  it('covers 1 s before to 3 s after a 5-minute boundary, both ends included', () => {
    expect(burstBoundary(B - 1_100)).toBeNull();
    expect(burstBoundary(B - 1_000)).toBe(B);
    expect(burstBoundary(B)).toBe(B);
    expect(burstBoundary(B + 3_000)).toBe(B);
    expect(burstBoundary(B + 3_100)).toBeNull();
    expect(burstBoundary(B + 150_000)).toBeNull();
  });
});

describe('Sampler.nextDue', () => {
  it('names the next tick that emits: whole seconds outside the burst window, every 100 ms inside it', () => {
    const { sampler } = make();
    sampler.start(B + 20_030);
    expect(sampler.nextTick).toBe(B + 20_100);
    expect(sampler.nextDue).toBe(B + 21_000);
    sampler.advance(B + 21_000);
    expect(sampler.nextDue).toBe(B + 22_000);

    // 4 s before the next boundary the burst window opens 1 s before it.
    const next = make();
    next.sampler.start(B + 299_000 - 1);
    expect(next.sampler.nextDue).toBe(B + 299_000);
    next.sampler.advance(B + 299_000);
    expect(next.sampler.nextDue).toBe(B + 299_100);
    next.sampler.advance(B + 303_000);
    expect(next.sampler.nextDue).toBe(B + 304_000);
  });

  it('emits exactly the same rows when advanced only at due ticks as when advanced every 100 ms', () => {
    const dense = make();
    const sparse = make();
    dense.sampler.start(B + 290_000);
    sparse.sampler.start(B + 290_000);
    for (let now = B + 290_000; now <= B + 306_000; now += 100) dense.sampler.advance(now);
    let now = B + 290_000;
    while (now <= B + 306_000) {
      now = sparse.sampler.nextDue;
      sparse.sampler.advance(now);
    }
    const key = (r: { stream: string; row: { t: number; coin: string } }) => `${r.stream}|${r.row.t}|${r.row.coin}`;
    // Compare up to the last tick both have reached.
    const upTo = B + 306_000;
    const d = dense.rows.filter((r) => r.row.t <= upTo).map(key);
    const s = sparse.rows.filter((r) => r.row.t <= upTo).map(key);
    expect(s).toEqual(d);
  });
});

describe('Sampler', () => {
  it('emits a 1 s row per coin per venue at every whole second and nothing between', () => {
    const { sampler, rows } = make();
    const start = B + 20_000 + 250;
    sampler.start(start);
    expect(sampler.nextTick).toBe(B + 20_300);
    sampler.advance(start + 100);
    expect(rows).toHaveLength(0);
    sampler.advance(B + 22_000);
    const ts = [...new Set(rows.map((r) => r.row.t))];
    expect(ts).toEqual([B + 21_000, B + 22_000]);
    expect(of(rows, 'lighter-1s')).toHaveLength(4);
    expect(of(rows, 'binance-1s')).toHaveLength(2);
    expect(of(rows, 'lighter-burst')).toHaveLength(0);
  });

  it('emits burst rows every 100 ms from 1 s before to 3 s after the boundary, with g', () => {
    const { sampler, rows } = make();
    sampler.start(B - 5_000);
    for (let now = B - 5_000; now <= B + 10_000; now += 100) sampler.advance(now);
    const lighterBurst = of(rows, 'lighter-burst').filter((r) => r.row.coin === 'BTC');
    const ts = lighterBurst.map((r) => r.row.t);
    expect(ts[0]).toBe(B - 1_000);
    expect(ts[ts.length - 1]).toBe(B + 3_000);
    expect(ts).toHaveLength(41);
    expect(new Set(ts).size).toBe(41);
    expect(lighterBurst.every((r) => (r.row as BurstRow).g === B)).toBe(true);
    expect(of(rows, 'binance-burst')).toHaveLength(41);
    expect(of(rows, 'lighter-burst')).toHaveLength(82);
    // 1 s rows keep coming through the window as well.
    expect(of(rows, 'binance-1s').filter((r) => r.row.t >= B - 1_000 && r.row.t <= B + 3_000)).toHaveLength(5);
  });

  it('keeps the grid time as t and marks a row sampled more than 50 ms late ok:false, reason late', () => {
    let price = 100;
    const { sampler, rows, gaps } = make({ quote: () => state({ bid: price, recv: price }) });
    sampler.start(B + 10_000);
    price = 105;
    sampler.advance(B + 13_050);
    const lighter = rows.filter((r) => r.stream === 'lighter-1s' && r.row.coin === 'BTC').map((r) => r.row);
    expect(lighter.map((r) => r.t)).toEqual([B + 11_000, B + 12_000, B + 13_000]);
    expect(lighter.every((r) => r.st === B + 13_050)).toBe(true);
    // 2,050 ms and 1,050 ms late: not trusted. Exactly 50 ms late: still fine.
    expect(lighter[0]).toMatchObject({ ok: false, reason: 'late', bid: null, ask: null, bidSz: null, rt100: null, rt20000: null });
    expect(lighter[0].recv).toBe(105);
    expect(lighter[1]).toMatchObject({ ok: false, reason: 'late' });
    expect(lighter[2]).toMatchObject({ ok: true, bid: 105 });
    expect(lighter[2]).not.toHaveProperty('reason');
    expect(gaps).toEqual([]);
  });

  it('the lateness limit is 50 ms: 51 ms late is late, 50 ms is not', () => {
    const { sampler, rows } = make();
    sampler.start(B + 999);
    sampler.advance(B + 1_050);
    expect(rows[0].row).toMatchObject({ t: B + 1_000, st: B + 1_050, ok: true });
    const second = make();
    second.sampler.start(B + 999);
    second.sampler.advance(B + 1_051);
    expect(second.rows[0].row).toMatchObject({ t: B + 1_000, st: B + 1_051, ok: false, reason: 'late' });
  });

  it('flags late burst rows too', () => {
    const { sampler, rows } = make();
    sampler.start(B - 1_000);
    sampler.advance(B - 500);
    const burst = rows.filter((r) => r.stream === 'lighter-burst' && r.row.coin === 'BTC').map((r) => r.row);
    expect(burst.map((r) => [r.t - B, r.ok])).toEqual([
      [-900, false],
      [-800, false],
      [-700, false],
      [-600, false],
      [-500, true],
    ]);
  });

  it('carries ok:false and null prices from the source and does not emit a tick twice', () => {
    const { sampler, rows } = make({
      quote: () => state({ ok: false, bid: null, ask: null, bidSz: null, askSz: null, rt100: null, rt1000: null, rt5000: null, rt20000: null }),
    });
    sampler.start(B);
    sampler.advance(B + 1_000);
    sampler.advance(B + 1_000);
    sampler.advance(B + 1_099);
    // One 1 s tick (B + 1,000) times two Lighter coins.
    expect(of(rows, 'lighter-1s')).toHaveLength(2);
    for (const { row } of rows) {
      expect(row).toMatchObject({ ok: false, bid: null, ask: null, rt100: null });
    }
  });

  it('writes the documented row shape', () => {
    const { sampler, rows } = make();
    sampler.start(B - 1);
    sampler.advance(B);
    const first = rows.find((r) => r.stream === 'lighter-1s' && r.row.coin === 'BTC');
    expect(first?.row).toEqual({
      t: B,
      st: B,
      coin: 'BTC',
      exch: 1,
      recv: 2,
      bid: 100,
      ask: 101,
      bidSz: 1,
      askSz: 2,
      rt100: 1,
      rt1000: 2,
      rt5000: 3,
      rt20000: 4,
      ok: true,
    });
    const burst = rows.find((r) => r.stream === 'lighter-burst');
    expect(burst?.row).toMatchObject({ t: B, g: B });
  });

  it('treats a coin the source does not know as not ok', () => {
    const { sampler, rows } = make({ quote: () => null });
    sampler.start(B - 1);
    sampler.advance(B);
    expect(rows[0].row).toMatchObject({ ok: false, bid: null, exch: null });
  });

  it('skips the oldest ticks of a long stall and reports the span', () => {
    const { sampler, rows, gaps } = make();
    sampler.start(B + 10_000);
    sampler.advance(B + 10_000 + 60_000);
    // Only the last 5 s of ticks are emitted.
    const seconds = [...new Set(of(rows, 'lighter-1s').map((r) => r.row.t))];
    expect(seconds).toEqual([B + 65_000, B + 66_000, B + 67_000, B + 68_000, B + 69_000, B + 70_000]);
    expect(gaps).toEqual([{ venue: 'tape', coin: null, reason: 'sampler-skip', from: B + 10_100, to: B + 64_900 }]);
  });

  it('throws if used before start', () => {
    const { sampler } = make();
    expect(() => sampler.advance(B)).toThrow('start');
  });
});
