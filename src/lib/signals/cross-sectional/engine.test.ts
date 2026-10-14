import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BINANCE_FUTURES_MAKER_FEE, BINANCE_FUTURES_TAKER_FEE, STUDY_SLIPPAGE_BPS } from '@/lib/backtest/cost-model';
import { computeCrossSectionalRanks, type SymbolBarSnapshot } from './factors';
import { computeCrossSectionalSignalFromCandles } from './generator';
import {
  RV_V1,
  RvDataError,
  rvComposite,
  rvBeta,
  rvFactors,
  rvInitialState,
  rvStep,
  rvTargets,
  type RvBar,
  type RvFactorRow,
  type RvFillBar,
  type RvSettlement,
  type RvStepInput,
  type RvSymbolInput,
  type RvTrackState,
} from './engine';
import { buildSyntheticUniverse } from './__fixtures__/rv-synthetic';
import golden from './__fixtures__/rv-golden.json';

const BAR = RV_V1.barMs;
const T = 1_790_000_000_000 - (1_790_000_000_000 % BAR);
const CLOSE = T + BAR;

describe('RV_V1', () => {
  it('is the frozen rv-v1 literal', () => {
    expect(RV_V1).toEqual({
      version: 'rv-v1',
      barMs: 28_800_000,
      weights: { mom: 0.3, idio: 0.25, carry: 0.3, flow: 0.15 },
      momBars: 42,
      flowBars: 43,
      legs: 2,
      buffer: 2,
      autoClampBuffer: true,
      betaNeutral: true,
      betaClamp: [0.1, 3.0],
      minUniverse: 5,
      winsorizeLimit: 3,
      startingEquity: 10_000,
      costs: { takerFee: 0.0005, makerFee: 0.0002, takerSlippageBps: 2 },
      makerWindowMs: 3_600_000,
    });
  });

  it('takes its fees and slippage from the cost model', () => {
    expect(BINANCE_FUTURES_TAKER_FEE).toBe(0.0005);
    expect(BINANCE_FUTURES_MAKER_FEE).toBe(0.0002);
    expect(RV_V1.costs.takerFee).toBe(BINANCE_FUTURES_TAKER_FEE);
    expect(RV_V1.costs.makerFee).toBe(BINANCE_FUTURES_MAKER_FEE);
    expect(RV_V1.costs.takerSlippageBps).toBe(STUDY_SLIPPAGE_BPS['8h']);
  });
});

describe('engine purity', () => {
  it('imports only factors, portfolio and the cost model', () => {
    const src = readFileSync(join(__dirname, 'engine.ts'), 'utf8');
    const specifiers = [...src.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) {
      expect(['./factors', './portfolio', '@/lib/backtest/cost-model']).toContain(s);
    }
    expect(src).not.toMatch(/^\s*import\s+['"]/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/Date\.now\(/);
    expect(src).not.toMatch(/\bfetch\(/);
  });
});

// ---------------------------------------------------------------- factors

/** Closes compounding `rets` from `start`: rets.length + 1 values. */
function closesFrom(start: number, rets: number[]): number[] {
  const out = [start];
  for (const r of rets) out.push(out[out.length - 1] * (1 + r));
  return out;
}

function barsOf(closes: number[], barTime = T, opts: { volume?: number; takerFrac?: number | null } = {}): RvBar[] {
  const n = closes.length;
  const volume = opts.volume ?? 1000;
  const frac = opts.takerFrac === undefined ? 0.5 : opts.takerFrac;
  return closes.map((close, i) => ({
    openTime: barTime - (n - 1 - i) * BAR,
    close,
    volume,
    takerBuyVolume: frac === null ? null : volume * frac,
  }));
}

const settle = (rate: number, fundingTime = CLOSE, markPrice: number | null = 100): RvSettlement => ({
  fundingTime,
  rate,
  markPrice,
});

const btcRets = Array.from({ length: 42 }, (_, t) => 0.01 * Math.sin(1.3 * t) + 0.004 * Math.cos(0.7 * t + 1));

function universe(extra: Partial<Record<string, RvSymbolInput>> = {}): RvSymbolInput[] {
  const defs: [string, number, number][] = [
    ['BTCUSDT', 1, 0],
    ['ETHUSDT', 2, 0.001],
    ['SOLUSDT', 3, -0.001],
    ['XRPUSDT', 0.5, 0.0005],
    ['ADAUSDT', 1.5, -0.0005],
    ['DOGEUSDT', 2.5, 0.0002],
  ];
  return defs.map(([symbol, mult, drift], k) => {
    const rets = btcRets.map((r, t) => mult * r + (symbol === 'BTCUSDT' ? 0 : drift + 0.002 * Math.sin(t * (k + 2))));
    const base: RvSymbolInput = {
      symbol,
      bars: barsOf(closesFrom(100 + k * 10, rets), T, { takerFrac: 0.48 + k * 0.01 }),
      lastSettlement: settle(0.0001 * (k - 2)),
    };
    return extra[symbol] ?? base;
  });
}

function withSymbol(symbol: string, patch: Partial<RvSymbolInput>): RvSymbolInput[] {
  const base = universe().find((u) => u.symbol === symbol)!;
  return universe({ [symbol]: { ...base, ...patch } });
}

describe('rvFactors', () => {
  it('computes mom, carry and flow from the last 43 bars', () => {
    const res = rvFactors(universe(), T);
    expect(res.barTime).toBe(T);
    expect(res.skipped).toEqual([]);
    expect(res.rows.map((r) => r.symbol)).toEqual(universe().map((u) => u.symbol));
    const eth = res.rows.find((r) => r.symbol === 'ETHUSDT')!;
    const ethBars = universe().find((u) => u.symbol === 'ETHUSDT')!.bars;
    expect(eth.mom).toBeCloseTo(ethBars[42].close / ethBars[0].close - 1, 12);
    expect(eth.carry).toBeCloseTo(-0.0001 * (1 - 2), 12);
    expect(eth.flow).toBeCloseTo(0.49 - 0.5, 12);
  });

  it('gives BTC beta exactly 1 and idio = mom - beta * btcMom', () => {
    const res = rvFactors(universe(), T);
    const btc = res.rows.find((r) => r.symbol === 'BTCUSDT')!;
    expect(btc.beta).toBe(1);
    expect(btc.idio).toBeCloseTo(0, 12);
    for (const r of res.rows) expect(r.idio).toBeCloseTo(r.mom - r.beta * btc.mom, 12);
  });

  it('measures beta from heterogeneous returns, paired by open time', () => {
    const res = rvFactors(universe(), T);
    const beta = (s: string) => res.rows.find((r) => r.symbol === s)!.beta;
    // XRP and the others carry noise, so use symbols built as exact multiples of BTC
    const exact = (mult: number) =>
      universe({
        ETHUSDT: { symbol: 'ETHUSDT', bars: barsOf(closesFrom(50, btcRets.map((r) => mult * r))), lastSettlement: settle(0) },
      });
    const r2 = rvFactors(exact(2), T).rows.find((r) => r.symbol === 'ETHUSDT')!;
    expect(r2.beta).toBeCloseTo(2, 9);
    expect(rvFactors(exact(5), T).rows.find((r) => r.symbol === 'ETHUSDT')!.beta).toBe(3);
    expect(rvFactors(exact(-0.5), T).rows.find((r) => r.symbol === 'ETHUSDT')!.beta).toBe(0.1);
    expect(beta('SOLUSDT')).toBeGreaterThan(0.1);
    expect(beta('SOLUSDT')).not.toBeCloseTo(1, 2);
  });

  it('uses beta 1 when BTC returns are constant (no variance to regress on)', () => {
    const flat = Array.from({ length: 42 }, () => 0.01);
    const inputs = universe({
      BTCUSDT: { symbol: 'BTCUSDT', bars: barsOf(closesFrom(100, flat)), lastSettlement: settle(0) },
    });
    const res = rvFactors(inputs, T);
    for (const r of res.rows) expect(r.beta).toBe(1);
  });

  it('gives the same result when a symbol supplies its bars in shuffled order', () => {
    const base = universe();
    const sorted = rvFactors(base, T);
    const eth = base.find((u) => u.symbol === 'ETHUSDT')!;
    const shuffled = [...eth.bars].sort((a, b) => ((a.openTime / BAR) * 7919) % 13 - ((b.openTime / BAR) * 7919) % 13);
    expect(shuffled.map((b) => b.openTime)).not.toEqual(eth.bars.map((b) => b.openTime));
    const res = rvFactors(withSymbol('ETHUSDT', { bars: shuffled }), T);
    expect(res).toEqual(sorted);
  });

  it('ignores extreme values and a gap in bars older than the 43-bar window', () => {
    const base = universe();
    const sorted = rvFactors(base, T);
    const older = (first: number): RvBar[] =>
      Array.from({ length: 17 }, (_, k) => ({
        // a one-bar gap sits in the middle of the old history
        openTime: first - (k + 1 + (k >= 8 ? 1 : 0)) * BAR,
        close: k % 2 ? 1e9 : Number.NaN,
        volume: Number.NaN,
        takerBuyVolume: null,
      }));
    const padded = base.map((u) => ({ ...u, bars: [...older(u.bars[0].openTime), ...u.bars] }));
    expect(padded[0].bars).toHaveLength(60);
    expect(rvFactors(padded, T)).toEqual(sorted);
  });

  it('throws bad_config when the momentum window does not fit in the flow window', () => {
    expect(() => rvFactors(universe(), T, { ...RV_V1, momBars: 43 })).toThrow(
      expect.objectContaining({ code: 'bad_config' })
    );
  });

  it('accepts a settlement exactly at the bar close and rejects one at or before the previous close', () => {
    const at = rvFactors(withSymbol('ETHUSDT', { lastSettlement: settle(0.001, CLOSE) }), T);
    expect(at.skipped).toEqual([]);
    expect(at.rows.find((r) => r.symbol === 'ETHUSDT')!.carry).toBeCloseTo(-0.001, 12);
    const old = rvFactors(withSymbol('ETHUSDT', { lastSettlement: settle(0.001, CLOSE - BAR) }), T);
    expect(old.skipped).toEqual([{ symbol: 'ETHUSDT', reason: 'carry_stale' }]);
  });

  it('ignores a settlement after the bar close instead of using it', () => {
    const res = rvFactors(withSymbol('ETHUSDT', { lastSettlement: settle(0.5, CLOSE + 1) }), T);
    expect(res.skipped).toEqual([{ symbol: 'ETHUSDT', reason: 'carry_stale' }]);
    expect(res.rows.map((r) => r.symbol)).not.toContain('ETHUSDT');
  });

  it('skips with carry_missing instead of carry 0', () => {
    const res = rvFactors(withSymbol('ETHUSDT', { lastSettlement: null }), T);
    expect(res.skipped).toEqual([{ symbol: 'ETHUSDT', reason: 'carry_missing' }]);
  });

  it('skips with flow_missing for null, non-finite or zero taker volume', () => {
    const eth = universe().find((u) => u.symbol === 'ETHUSDT')!;
    const patch = (fn: (b: RvBar) => RvBar) => eth.bars.map((b, i) => (i === 10 ? fn(b) : b));
    for (const bars of [
      patch((b) => ({ ...b, takerBuyVolume: null })),
      patch((b) => ({ ...b, takerBuyVolume: Number.NaN })),
      eth.bars.map((b) => ({ ...b, volume: 0, takerBuyVolume: 0 })),
    ]) {
      expect(rvFactors(withSymbol('ETHUSDT', { bars }), T).skipped).toEqual([
        { symbol: 'ETHUSDT', reason: 'flow_missing' },
      ]);
    }
  });

  it('skips with flow_missing for negative volume, negative taker volume or taker above total', () => {
    const eth = universe().find((u) => u.symbol === 'ETHUSDT')!;
    const patch = (p: Partial<RvBar>) => eth.bars.map((b, i) => (i === 10 ? { ...b, ...p } : b));
    for (const bars of [
      patch({ volume: -1, takerBuyVolume: -1 }),
      patch({ takerBuyVolume: -5 }),
      patch({ takerBuyVolume: 1001 }),
    ]) {
      expect(rvFactors(withSymbol('ETHUSDT', { bars }), T).skipped).toEqual([
        { symbol: 'ETHUSDT', reason: 'flow_missing' },
      ]);
    }
  });

  it('throws bad_input when a beta pair cannot be aligned by open time', () => {
    const rets = new Map([[1, 0.01], [2, 0.02], [3, -0.01]]);
    const btc = new Map([[1, 0.01], [2, 0.02], [4, -0.01]]);
    expect(() => rvBeta(rets, btc, RV_V1)).toThrow(expect.objectContaining({ code: 'bad_input' }));
  });

  it('skips with bars_not_contiguous for a gap inside the window', () => {
    const eth = universe().find((u) => u.symbol === 'ETHUSDT')!;
    const gapped = eth.bars.map((b, i) => (i < 20 ? { ...b, openTime: b.openTime - BAR } : b));
    expect(rvFactors(withSymbol('ETHUSDT', { bars: gapped }), T).skipped).toEqual([
      { symbol: 'ETHUSDT', reason: 'bars_not_contiguous' },
    ]);
  });

  it('skips with bars_incomplete for short history or a last bar away from barTime', () => {
    const eth = universe().find((u) => u.symbol === 'ETHUSDT')!;
    expect(rvFactors(withSymbol('ETHUSDT', { bars: eth.bars.slice(1) }), T).skipped).toEqual([
      { symbol: 'ETHUSDT', reason: 'bars_incomplete' },
    ]);
    expect(rvFactors(withSymbol('ETHUSDT', { bars: eth.bars.slice(0, 42) }), T).skipped).toEqual([
      { symbol: 'ETHUSDT', reason: 'bars_incomplete' },
    ]);
  });

  it('never uses bars after barTime: a future bar makes the symbol incomplete', () => {
    const eth = universe().find((u) => u.symbol === 'ETHUSDT')!;
    const last = eth.bars[42];
    const future = [...eth.bars, { ...last, openTime: T + BAR, close: last.close * 10 }];
    const res = rvFactors(withSymbol('ETHUSDT', { bars: future }), T);
    expect(res.skipped).toEqual([{ symbol: 'ETHUSDT', reason: 'bars_incomplete' }]);
  });

  it('throws btc_missing when BTC is absent or skipped', () => {
    const noBtc = universe().filter((u) => u.symbol !== 'BTCUSDT');
    expect(() => rvFactors(noBtc, T)).toThrowError(RvDataError);
    expect(() => rvFactors(noBtc, T)).toThrow(expect.objectContaining({ code: 'btc_missing' }));
    expect(() => rvFactors(withSymbol('BTCUSDT', { lastSettlement: null }), T)).toThrow(
      expect.objectContaining({ code: 'btc_missing' })
    );
  });

  it('throws universe_too_small with 4 survivors', () => {
    const four = universe().slice(0, 4);
    expect(() => rvFactors(four, T)).toThrow(expect.objectContaining({ code: 'universe_too_small' }));
    const five = universe().slice(0, 5);
    expect(rvFactors(five, T).rows).toHaveLength(5);
  });

  it('standardises over the surviving symbols only', () => {
    const full = rvFactors(universe(), T);
    const sum = full.rows.reduce((s, r) => s + r.zMom, 0);
    expect(sum).toBeCloseTo(0, 9);
    const partial = rvFactors(withSymbol('DOGEUSDT', { lastSettlement: null }), T);
    expect(partial.rows).toHaveLength(5);
    expect(partial.rows.reduce((s, r) => s + r.zCarry, 0)).toBeCloseTo(0, 9);
  });
});

// -------------------------------------------------------------- composite

describe('rvComposite', () => {
  it('matches computeCrossSectionalRanks for the same inputs', () => {
    const { barTime, inputs } = buildSyntheticUniverse();
    const rows = rvFactors(inputs, barTime).rows;
    const mine = rvComposite(rows, RV_V1.weights);
    const btc = rows.find((r) => r.symbol === 'BTCUSDT')!;
    const snaps: SymbolBarSnapshot[] = rows.map((r) => ({
      symbol: r.symbol,
      close: 1,
      return7d: r.mom,
      return14d: r.mom,
      fundingRate: -r.carry,
      btcReturn14d: btc.mom,
      betaToBtc: r.beta,
      takerBuyRatio: r.flow + 0.5,
    }));
    const legacy = computeCrossSectionalRanks(snaps, { ...RV_V1.weights, news: 0, vol: 0 });
    expect(mine.map((m) => m.symbol)).toEqual(legacy.map((l) => l.symbol));
    expect(mine.map((m) => m.rank)).toEqual(legacy.map((l) => l.rank));
    mine.forEach((m, i) => expect(m.compositeZ).toBeCloseTo(legacy[i].compositeZ, 12));
  });

  it('sorts descending, breaks ties by symbol and counts a missing weight as 0', () => {
    const row = (symbol: string, z: number): RvFactorRow => ({
      symbol, mom: 0, idio: 0, carry: 0, flow: 0, beta: 1, zMom: z, zIdio: 5, zCarry: 5, zFlow: 5,
    });
    const out = rvComposite([row('B', 1), row('A', 1), row('C', 2)], { mom: 1 });
    expect(out.map((o) => [o.symbol, o.rank, o.compositeZ])).toEqual([
      ['C', 1, 2],
      ['A', 2, 1],
      ['B', 3, 1],
    ]);
  });
});

// ---------------------------------------------------------------- targets

const names = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'];
const ranked = names.map((symbol, i) => ({ symbol, compositeZ: 10 - i, rank: i + 1 }));
const noBetas = new Map<string, number>();
const plain = { legs: 2, buffer: 2, betaNeutral: false, autoClampBuffer: true };

describe('rvTargets', () => {
  it('throws held_symbol_unscored for a held symbol missing from the ranking', () => {
    expect(() => rvTargets(ranked, new Map([['GONE', 1 as const]]), noBetas)).toThrow(RvDataError);
    expect(() => rvTargets(ranked, new Map([['GONE', -1 as const]]), noBetas)).toThrow(
      expect.objectContaining({ code: 'held_symbol_unscored' })
    );
  });

  it('keeps the best-ranked retained longs, not the first inserted', () => {
    const held = new Map<string, 1 | -1>([['S4', 1], ['S1', 1], ['S3', 1]]);
    const out = rvTargets(ranked, held, noBetas, plain);
    expect([...out.entries()].filter(([, w]) => w > 0).map(([s]) => s).sort()).toEqual(['S1', 'S3']);
    expect(out.has('S4')).toBe(false);
  });

  it('keeps the best-ranked retained shorts (highest ranks)', () => {
    const held = new Map<string, -1 | 1>([['S7', -1], ['S10', -1], ['S8', -1]]);
    const out = rvTargets(ranked, held, noBetas, plain);
    expect([...out.entries()].filter(([, w]) => w < 0).map(([s]) => s).sort()).toEqual(['S10', 'S8']);
  });

  it('exits a leg that falls past the buffer and fills from the extremes', () => {
    const out = rvTargets(ranked, new Map([['S5', 1 as const]]), noBetas, plain);
    expect(out.has('S5')).toBe(false);
    expect(out.get('S1')).toBe(0.25);
    expect(out.get('S2')).toBe(0.25);
    expect(out.get('S10')).toBe(-0.25);
    expect(out.get('S9')).toBe(-0.25);
  });

  it('uses equal weights without beta neutrality and basket-average sizing with it', () => {
    const equal = rvTargets(ranked, new Map(), noBetas, plain);
    expect([...equal.values()].sort()).toEqual([-0.25, -0.25, 0.25, 0.25]);

    const betas = new Map(names.map((n) => [n, n === 'S9' || n === 'S10' ? 2 : 1]));
    const neutral = rvTargets(ranked, new Map(), betas, { ...plain, betaNeutral: true });
    expect(neutral.get('S1')).toBeCloseTo(1 / 3, 12);
    expect(neutral.get('S2')).toBeCloseTo(1 / 3, 12);
    expect(neutral.get('S9')).toBeCloseTo(-1 / 6, 12);
    expect(neutral.get('S10')).toBeCloseTo(-1 / 6, 12);
  });

  it('throws beta_missing when beta neutrality is on and a ranked symbol has no finite beta', () => {
    const betas = new Map(names.map((n) => [n, 1]));
    betas.delete('S4');
    expect(() => rvTargets(ranked, new Map(), betas)).toThrow(expect.objectContaining({ code: 'beta_missing' }));
    betas.set('S4', Number.NaN);
    expect(() => rvTargets(ranked, new Map(), betas)).toThrow(expect.objectContaining({ code: 'beta_missing' }));
    expect(rvTargets(ranked, new Map(), new Map(), plain).size).toBe(4);
  });

  it('defaults to the rv-v1 cell', () => {
    const betas = new Map(names.map((n) => [n, 1]));
    const out = rvTargets(ranked, new Map(), betas);
    expect(out.size).toBe(4);
  });
});

describe('golden parity with the legacy generator', () => {
  const { barTime, inputs, candles, funding } = buildSyntheticUniverse();

  function pure(held: Map<string, 1 | -1>) {
    const f = rvFactors(inputs, barTime);
    const betas = new Map(f.rows.map((r) => [r.symbol, r.beta]));
    return { ranks: rvComposite(f.rows, RV_V1.weights), targets: (r: ReturnType<typeof rvComposite>) => rvTargets(r, held, betas) };
  }
  const toObj = (m: Map<string, number>) => Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));

  it('matches with no held positions and equals the saved fixture', () => {
    const { ranks, targets } = pure(new Map());
    const legacy = computeCrossSectionalSignalFromCandles(candles, funding, new Map());
    const legacyTargets = Object.fromEntries(
      legacy.targets.filter((t) => t.side !== 'flat').map((t) => [t.symbol, t.weight]).sort(([a], [b]) => String(a).localeCompare(String(b)))
    );
    const mine = toObj(targets(ranks));
    expect(Object.keys(mine)).toEqual(Object.keys(legacyTargets));
    for (const k of Object.keys(mine)) expect(mine[k]).toBeCloseTo(legacyTargets[k] as number, 12);
    const fixture = golden.flat;
    expect(Object.keys(mine)).toEqual(Object.keys(fixture));
    for (const k of Object.keys(mine)) expect(mine[k]).toBeCloseTo((fixture as Record<string, number>)[k], 9);
  });

  it('matches with one retained long and one retained short', () => {
    const base = pure(new Map());
    const heldLong = base.ranks[2].symbol;
    const heldShort = base.ranks[base.ranks.length - 3].symbol;
    const held = new Map<string, 1 | -1>([[heldLong, 1], [heldShort, -1]]);
    const { ranks, targets } = pure(held);
    const legacy = computeCrossSectionalSignalFromCandles(
      candles,
      funding,
      new Map([[heldLong, 0.25], [heldShort, -0.25]])
    );
    const legacyTargets = Object.fromEntries(
      legacy.targets.filter((t) => t.side !== 'flat').map((t) => [t.symbol, t.weight]).sort(([a], [b]) => String(a).localeCompare(String(b)))
    );
    const mine = toObj(targets(ranks));
    expect(mine[heldLong]).toBeGreaterThan(0);
    expect(mine[heldShort]).toBeLessThan(0);
    expect(Object.keys(mine)).toEqual(Object.keys(legacyTargets));
    for (const k of Object.keys(mine)) expect(mine[k]).toBeCloseTo(legacyTargets[k] as number, 12);
    expect(golden.held.heldLong).toBe(heldLong);
    expect(golden.held.heldShort).toBe(heldShort);
    for (const k of Object.keys(mine)) expect(mine[k]).toBeCloseTo((golden.held.targets as Record<string, number>)[k], 9);
  });
});

// ------------------------------------------------------------- accounting

const fb = (open: number, extra: Partial<RvFillBar> = {}): RvFillBar => ({
  open, high: open * 1.01, low: open * 0.99, close: open, ...extra,
});

function step(
  state: RvTrackState,
  input: Partial<RvStepInput> & Pick<RvStepInput, 'fillBars' | 'targets'>
) {
  return rvStep(state, { track: 'taker', prevFillTime: null, fillTime: CLOSE, settlements: {}, ...input });
}

describe('rvStep taker', () => {
  const first = () => step(rvInitialState(), {
    fillBars: { A: fb(100), B: fb(50) },
    targets: { A: 0.5, B: -0.5 },
  });

  it('opens legs at slipped prices and pays taker fees (hand-computed)', () => {
    const { state, record } = first();
    const a = record.fills.find((f) => f.symbol === 'A')!;
    const b = record.fills.find((f) => f.symbol === 'B')!;
    expect(a.deltaQty).toBeCloseTo(50, 9);
    expect(a.price).toBeCloseTo(100.02, 9);
    expect(a.fee).toBeCloseTo(2.5005, 9);
    expect(a.kind).toBe('taker');
    expect(b.deltaQty).toBeCloseTo(-100, 9);
    expect(b.price).toBeCloseTo(49.99, 9);
    expect(b.fee).toBeCloseTo(2.4995, 9);
    expect(state.cash).toBeCloseTo(9993, 9);
    expect(record.equityBefore).toBe(10_000);
    expect(record.equityAfter).toBeCloseTo(9993, 9);
    expect(record.fees).toBeCloseTo(5, 9);
    expect(state.positions.A).toEqual({ qty: expect.closeTo(50, 9), avgEntry: expect.closeTo(100.02, 9), lastMark: 100 });
    expect(state.positions.B.avgEntry).toBeCloseTo(49.99, 9);
    expect(record.gross).toBeCloseTo(10_000 / 9993, 9);
    expect(record.unrealizedPnl).toBeCloseTo(50 * (100 - 100.02) + -100 * (50 - 49.99), 9);
  });

  it('charges funding on the position held across each settlement', () => {
    const { state } = first();
    const { state: next, record } = step(state, {
      prevFillTime: CLOSE,
      fillTime: CLOSE + BAR,
      settlements: {
        A: [{ fundingTime: CLOSE + BAR, rate: 0.0001, markPrice: 102 }],
        B: [{ fundingTime: CLOSE + BAR, rate: -0.0002, markPrice: 49 }],
      },
      fillBars: { A: fb(102), B: fb(49) },
      targets: { A: 0.5, B: -0.5 },
    });
    const a = record.funding.find((f) => f.symbol === 'A')!;
    const b = record.funding.find((f) => f.symbol === 'B')!;
    expect(a.amount).toBeCloseTo(-0.51, 9);
    expect(b.amount).toBeCloseTo(-0.98, 9);
    expect(a.markPrice).toBe(102);
    expect(next).toBeDefined();
  });

  it('falls back to the last mark when a settlement has no mark price, and skips settlements outside the interval', () => {
    const { state } = first();
    const { record } = step(state, {
      prevFillTime: CLOSE,
      fillTime: CLOSE + BAR,
      settlements: {
        A: [
          { fundingTime: CLOSE + BAR / 2, rate: 0.001, markPrice: null },
          { fundingTime: CLOSE, rate: 0.5, markPrice: 1 },
          { fundingTime: CLOSE + BAR + 1, rate: 0.5, markPrice: 1 },
        ],
      },
      fillBars: { A: fb(110), B: fb(50) },
      targets: { A: 0.5, B: -0.5 },
    });
    expect(record.funding).toHaveLength(1);
    expect(record.funding[0].amount).toBeCloseTo(-50 * 100 * 0.001, 9);
  });

  it('pays every settlement crossed, not just the latest', () => {
    const { state } = first();
    const { record } = step(state, {
      prevFillTime: CLOSE,
      fillTime: CLOSE + 2 * BAR,
      settlements: {
        A: [
          { fundingTime: CLOSE + BAR, rate: 0.0001, markPrice: 100 },
          { fundingTime: CLOSE + 2 * BAR, rate: 0.0001, markPrice: 100 },
        ],
      },
      fillBars: { A: fb(100), B: fb(50) },
      targets: { A: 0.5, B: -0.5 },
    });
    expect(record.funding.map((f) => f.amount)).toEqual([expect.closeTo(-0.5, 9), expect.closeTo(-0.5, 9)]);
  });

  it('reduces a position at the slipped price and realises PnL against the entry', () => {
    const state: RvTrackState = { cash: 4900, positions: { A: { qty: 50, avgEntry: 100.02, lastMark: 100 } } };
    const { state: next, record } = step(state, {
      prevFillTime: CLOSE - BAR,
      fillBars: { A: fb(102) },
      targets: { A: 0.204 },
    });
    expect(record.equityBefore).toBeCloseTo(10_000, 9);
    const f = record.fills[0];
    expect(f.deltaQty).toBeCloseTo(-30, 9);
    expect(f.price).toBeCloseTo(101.9796, 9);
    expect(f.realizedPnl).toBeCloseTo(58.788, 9);
    expect(f.fee).toBeCloseTo(1.529694, 9);
    expect(next.positions.A.qty).toBeCloseTo(20, 9);
    expect(next.positions.A.avgEntry).toBeCloseTo(100.02, 12);
    expect(record.realizedPnl).toBeCloseTo(58.788, 9);
  });

  it('re-averages the entry when adding in the same direction', () => {
    const state: RvTrackState = { cash: 8000, positions: { A: { qty: 20, avgEntry: 100, lastMark: 100 } } };
    const { state: next } = step(state, {
      prevFillTime: CLOSE - BAR,
      fillBars: { A: fb(100) },
      targets: { A: 0.5 },
    });
    expect(next.positions.A.qty).toBeCloseTo(50, 9);
    expect(next.positions.A.avgEntry).toBeCloseTo((20 * 100 + 30 * 100.02) / 50, 9);
  });

  it('realises the whole long on a flip and resets the entry to the fill price', () => {
    const state: RvTrackState = { cash: 4900, positions: { A: { qty: 50, avgEntry: 100.02, lastMark: 100 } } };
    const { state: next, record } = step(state, {
      prevFillTime: CLOSE - BAR,
      fillBars: { A: fb(102) },
      targets: { A: -0.204 },
    });
    const f = record.fills[0];
    expect(f.deltaQty).toBeCloseTo(-70, 9);
    expect(f.realizedPnl).toBeCloseTo(50 * (101.9796 - 100.02), 9);
    expect(next.positions.A.qty).toBeCloseTo(-20, 9);
    expect(next.positions.A.avgEntry).toBeCloseTo(101.9796, 9);
  });

  it('realises a short cover with the opposite sign and removes a closed position', () => {
    const state: RvTrackState = { cash: 15_000, positions: { B: { qty: -100, avgEntry: 50, lastMark: 50 } } };
    const { state: next, record } = step(state, {
      prevFillTime: CLOSE - BAR,
      fillBars: { B: fb(40) },
      targets: {},
    });
    const f = record.fills[0];
    expect(f.price).toBeCloseTo(40.008, 9);
    expect(f.realizedPnl).toBeCloseTo(100 * (50 - 40.008), 9);
    expect(next.positions.B).toBeUndefined();
  });

  it('holds a symbol with no fill bar unchanged, marks it stale, and trades it when the bar returns', () => {
    const state: RvTrackState = { cash: 5000, positions: { A: { qty: 50, avgEntry: 100, lastMark: 100 } } };
    const missed = step(state, { prevFillTime: CLOSE - BAR, fillBars: { A: null }, targets: { A: 0 } });
    expect(missed.record.stale).toEqual(['A']);
    expect(missed.record.fills).toEqual([]);
    expect(missed.state.positions.A).toEqual({ qty: 50, avgEntry: 100, lastMark: 100 });
    expect(missed.record.equityBefore).toBe(10_000);

    const back = step(missed.state, { prevFillTime: CLOSE, fillTime: CLOSE + BAR, fillBars: { A: fb(90) }, targets: { A: 0 } });
    expect(back.record.stale).toEqual([]);
    expect(back.record.fills[0].price).toBeCloseTo(90 * 0.9998, 9);
    expect(back.state.positions.A).toBeUndefined();
  });

  it('skips a new entry that has no fill bar', () => {
    const { state, record } = step(rvInitialState(), {
      fillBars: { A: fb(100), B: null },
      targets: { A: 0.5, B: -0.5 },
    });
    expect(record.skippedEntries).toEqual(['B']);
    expect(state.positions.B).toBeUndefined();
    expect(record.fills.map((f) => f.symbol)).toEqual(['A']);
  });

  it('sizes every leg from one equity snapshot, independent of target order', () => {
    const bars = { A: fb(100), B: fb(50), C: fb(20) };
    const one = step(rvInitialState(), { fillBars: bars, targets: { A: 0.25, B: -0.25, C: 0.25 } });
    const two = step(rvInitialState(), { fillBars: bars, targets: { C: 0.25, B: -0.25, A: 0.25 } });
    const qty = (s: RvTrackState) => Object.fromEntries(Object.entries(s.positions).map(([k, v]) => [k, v.qty]));
    expect(qty(one.state)).toEqual(qty(two.state));
    expect(one.state.positions.A.qty).toBeCloseTo(25, 9);
    expect(one.state.positions.C.qty).toBeCloseTo(125, 9);
    expect(one.state.cash).toBe(two.state.cash);
  });

  it('halts without sizing or trading when equity is not positive', () => {
    const state: RvTrackState = { cash: -6000, positions: { A: { qty: 50, avgEntry: 100, lastMark: 100 } } };
    const { record, state: next } = step(state, {
      prevFillTime: CLOSE - BAR,
      fillBars: { A: fb(100), B: fb(50) },
      targets: { A: 0.5, B: -0.5 },
    });
    expect(record.equityBefore).toBeCloseTo(-1000, 9);
    expect(record.halted).toBe('equity_non_positive');
    expect(record.fills).toEqual([]);
    expect(record.skippedEntries).toEqual([]);
    expect(next.positions).toEqual(state.positions);
    expect(next.cash).toBe(-6000);
    expect(record.equityAfter).toBeCloseTo(-1000, 9);
    expect(record.gross).toBeNull();
  });

  it('does not halt at positive equity', () => {
    const { record } = first();
    expect(record.halted).toBeNull();
    expect(record.gross).not.toBeNull();
  });

  it('treats a non-finite settlement mark price as missing', () => {
    const { state } = first();
    const { record } = step(state, {
      prevFillTime: CLOSE,
      fillTime: CLOSE + BAR,
      settlements: { A: [{ fundingTime: CLOSE + BAR, rate: 0.001, markPrice: Number.NaN }] },
      fillBars: { A: fb(110), B: fb(50) },
      targets: { A: 0.5, B: -0.5 },
    });
    expect(record.funding[0].markPrice).toBe(100);
    expect(record.funding[0].amount).toBeCloseTo(-5, 9);
  });

  it('throws bad_input on a non-finite settlement rate', () => {
    const { state } = first();
    expect(() =>
      step(state, {
        prevFillTime: CLOSE,
        fillTime: CLOSE + BAR,
        settlements: { A: [{ fundingTime: CLOSE + BAR, rate: Number.NaN, markPrice: 100 }] },
        fillBars: { A: fb(100), B: fb(50) },
        targets: {},
      })
    ).toThrow(expect.objectContaining({ code: 'bad_input' }));
  });

  it.each([
    ['open', { open: Number.NaN }],
    ['high', { high: Number.POSITIVE_INFINITY }],
    ['low', { low: 0 }],
    ['close', { close: -1 }],
  ])('throws bad_input on a bad fill bar %s', (_name, patch) => {
    expect(() =>
      step(rvInitialState(), { fillBars: { A: fb(100, patch as Partial<RvFillBar>) }, targets: { A: 0.5 } })
    ).toThrow(expect.objectContaining({ code: 'bad_input' }));
  });

  it('throws bad_input when prevFillTime is null but positions are held', () => {
    const state: RvTrackState = { cash: 5000, positions: { A: { qty: 50, avgEntry: 100, lastMark: 100 } } };
    expect(() => step(state, { fillBars: { A: fb(100) }, targets: {} })).toThrow(
      expect.objectContaining({ code: 'bad_input' })
    );
  });
});

describe('rvStep maker', () => {
  it('fills at the reference with the maker fee when the bar trades through', () => {
    const { record, state } = rvStep(rvInitialState(), {
      track: 'maker',
      prevFillTime: null,
      fillTime: CLOSE,
      settlements: {},
      fillBars: { A: fb(100, { low: 99.5 }), B: fb(50, { high: 50.5 }) },
      targets: { A: 0.5, B: -0.5 },
    });
    for (const f of record.fills) {
      expect(f.kind).toBe('maker');
      expect(f.fee).toBeCloseTo(1, 9);
    }
    expect(record.fills.find((f) => f.symbol === 'A')!.price).toBe(100);
    expect(record.fills.find((f) => f.symbol === 'B')!.price).toBe(50);
    expect(state.cash).toBeCloseTo(9998, 9);
    expect(record.equityAfter).toBeCloseTo(9998, 9);
  });

  it('falls back to a slipped taker fill at the bar close when the bar does not trade through', () => {
    const { record } = rvStep(rvInitialState(), {
      track: 'maker',
      prevFillTime: null,
      fillTime: CLOSE,
      settlements: {},
      fillBars: {
        A: { open: 100, high: 101, low: 100, close: 100.5 },
        B: { open: 50, high: 50, low: 49, close: 49.5 },
      },
      targets: { A: 0.5, B: -0.5 },
    });
    const a = record.fills.find((f) => f.symbol === 'A')!;
    const b = record.fills.find((f) => f.symbol === 'B')!;
    expect(a.kind).toBe('taker_fallback');
    expect(a.price).toBeCloseTo(100.5 * 1.0002, 9);
    expect(a.fee).toBeCloseTo(Math.abs(a.deltaQty) * a.price * 0.0005, 9);
    expect(b.kind).toBe('taker_fallback');
    expect(b.price).toBeCloseTo(49.5 * 0.9998, 9);
  });
});

describe('rvInitialState', () => {
  it('starts with the configured equity and no positions', () => {
    expect(rvInitialState()).toEqual({ cash: 10_000, positions: {} });
  });
});
