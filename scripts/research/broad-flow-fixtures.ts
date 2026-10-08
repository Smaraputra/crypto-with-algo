/**
 * Synthetic universes for the broad flow phase's tests and wall-time estimate: the broad trend fixtures
 * (broad-fixtures.ts) with taker-buy volume added from a separate seeded stream, and a planted-flow generator
 * whose returns depend on the flow of the same day (lag 0) or the day before (lag 1). No real data is read.
 */
import { createSeededRandom } from '@/lib/stats/seeded-random';
import {
  syntheticFunding,
  syntheticRows,
  type SyntheticOptions,
  type SyntheticSpec,
  type SyntheticUniverse,
} from './broad-fixtures';
import { buildFlowInputs, type FlowInputs } from './broad-flow';
import { DAY_MS, dayStartMs, segmentContracts, universeFile } from './broad-trend';
import type { FundingRow, PerpCandleRow } from './dataset-format';

function normal(random: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** A copy of the rows with tbv = v x share on every traded row, share = 0.5 + spread x z clamped to [0.05, 0.95]. */
export function withTakerBuy(rows: readonly PerpCandleRow[], seed: number, spread = 0.08): PerpCandleRow[] {
  const random = createSeededRandom(seed);
  return rows.map((row) => (row.v > 0 ? { ...row, tbv: row.v * clamp(0.5 + spread * normal(random), 0.05, 0.95) } : { ...row }));
}

/** A universe from given rows: contracts, the universe file and its basket (as broad-fixtures.ts syntheticUniverse). */
export function universeFromRows(
  perp: Record<string, PerpCandleRow[]>,
  funding: Record<string, FundingRow[]>,
  options: SyntheticOptions,
  datasetHash = 'synthetic-flow-export'
): SyntheticUniverse {
  const contracts = Object.keys(perp)
    .sort()
    .flatMap((symbol) => segmentContracts(symbol, perp[symbol]));
  const universe = universeFile({ sourceDatasetHash: datasetHash, contracts, universe: options.universe, basket: options.basket });
  return { datasetHash, perp, funding, universe };
}

/** buildFlowInputs over a synthetic universe held in memory. */
export function flowInputsOf(u: SyntheticUniverse): FlowInputs {
  return buildFlowInputs({
    datasetHash: u.datasetHash,
    universe: u.universe,
    perp: (symbol) => ({ rows: u.perp[symbol] ?? [], lockboxApplied: true }),
    funding: (symbol) => ({ rows: u.funding[symbol] ?? [], lockboxApplied: true }),
  });
}

/** Twelve members from the 2021-01-01 close among fifteen contracts; the basket is unused by the flow rules. */
export const FLOW_OPTIONS: SyntheticOptions = {
  universe: { from: '2021-01-01', to: '2026-07-01', minBars: 366, topN: 12, minEligibleToStart: 10 },
  basket: { from: '2020-02-01', to: '2026-07-01', minBars: 30, topN: 15, minEligibleToStart: 0 },
};

/**
 * Fifteen contracts: BTC, ETH and SOL (legends assets), a delisting (KKK, 2024-03-15), a 3-day halt inside a
 * contract (LLL), a 10-day halt that splits MMM into two contracts, a late listing (NNN) and a 4-hour funding
 * interval (OOO). Volumes are spaced so the top twelve churn at the margin.
 */
export const FLOW_SPECS: SyntheticSpec[] = [
  { symbol: 'BTCUSDT', start: '2020-01-01', seed: 101, volume: 1e10, vol: 0.035, drift: 0.0004 },
  { symbol: 'ETHUSDT', start: '2020-01-01', seed: 102, volume: 6e9, vol: 0.045, drift: 0.0004 },
  { symbol: 'SOLUSDT', start: '2020-01-01', seed: 103, volume: 3e9, vol: 0.06, drift: 0.0006 },
  { symbol: 'AAAUSDT', start: '2020-01-01', seed: 104, volume: 2e9, vol: 0.05 },
  { symbol: 'BBBUSDT', start: '2020-01-01', seed: 105, volume: 1.6e9, vol: 0.05, drift: -0.0004 },
  { symbol: 'CCCUSDT', start: '2020-01-01', seed: 106, volume: 1.3e9, vol: 0.055 },
  { symbol: 'DDDUSDT', start: '2020-01-01', seed: 107, volume: 1.1e9, vol: 0.06 },
  { symbol: 'EEEUSDT', start: '2020-01-01', seed: 108, volume: 9e8, vol: 0.05, drift: 0.0003 },
  { symbol: 'FFFUSDT', start: '2020-01-01', seed: 109, volume: 8e8, vol: 0.065 },
  { symbol: 'GGGUSDT', start: '2020-01-01', seed: 110, volume: 7e8, vol: 0.05 },
  { symbol: 'KKKUSDT', start: '2020-01-01', end: '2024-03-15', seed: 111, volume: 6.5e8, vol: 0.07 },
  { symbol: 'LLLUSDT', start: '2020-01-01', seed: 112, volume: 6e8, vol: 0.06, halted: [1200, 1201, 1202] },
  { symbol: 'MMMUSDT', start: '2020-01-01', seed: 113, volume: 5.5e8, vol: 0.07, halted: [1500, 1501, 1502, 1503, 1504, 1505, 1506, 1507, 1508, 1509] },
  { symbol: 'NNNUSDT', start: '2021-06-01', seed: 114, volume: 5e8, vol: 0.06 },
  { symbol: 'OOOUSDT', start: '2020-01-01', seed: 115, volume: 1.2e9, vol: 0.06, intervalHours: 4 },
];

/** The fixture universe with taker-buy volume (seed per contract 1000 + its index). */
export function flowUniverse(specs: readonly SyntheticSpec[] = FLOW_SPECS, options: SyntheticOptions = FLOW_OPTIONS): SyntheticUniverse {
  const perp: Record<string, PerpCandleRow[]> = {};
  const funding: Record<string, FundingRow[]> = {};
  specs.forEach((spec, k) => {
    const rows = syntheticRows(spec);
    perp[spec.symbol] = withTakerBuy(rows, 1000 + k);
    funding[spec.symbol] = syntheticFunding(spec, rows);
  });
  return universeFromRows(perp, funding, options);
}

export interface PlantSpec {
  symbol: string;
  start: string;
  end?: string;
  seed: number;
  volume: number;
  vol?: number;
}

/**
 * Rows whose daily return on day k is vol x z + beta x (share of day k - lag - 0.5), the share being the day's
 * taker-buy share of volume (0.5 + 0.1 z, clamped). lag 1: today's flow predicts tomorrow's return; lag 0: flow
 * and return move together on the same day and nothing is predictable.
 */
export function plantedRows(spec: PlantSpec, beta: number, lag: 0 | 1): PerpCandleRow[] {
  const prices = createSeededRandom(spec.seed);
  const flows = createSeededRandom(spec.seed + 50_000);
  const from = dayStartMs(spec.start);
  const to = dayStartMs(spec.end ?? '2026-06-30');
  const vol = spec.vol ?? 0.03;
  const rows: PerpCandleRow[] = [];
  const shares: number[] = [];
  let c = 100;
  for (let k = 0, t = from; t <= to; k++, t += DAY_MS) {
    const share = clamp(0.5 + 0.1 * normal(flows), 0.05, 0.95);
    shares.push(share);
    const planted = k - lag >= 0 ? beta * (shares[k - lag] - 0.5) : 0;
    const o = c;
    c = Math.max(1e-6, c * (1 + vol * normal(prices) + planted));
    const qv = spec.volume * (0.8 + 0.4 * prices());
    const v = qv / c;
    rows.push({ t, o, h: Math.max(o, c), l: Math.min(o, c), c, v, qv, n: 100, tbv: v * share });
  }
  return rows;
}

/** A universe of `count` planted contracts listed on 2020-01-01, all members (topN = count). */
export function plantedUniverse(count: number, beta: number, lag: 0 | 1): SyntheticUniverse {
  const perp: Record<string, PerpCandleRow[]> = {};
  const funding: Record<string, FundingRow[]> = {};
  for (let k = 0; k < count; k++) {
    const spec: PlantSpec = { symbol: `P${String(k).padStart(2, '0')}USDT`, start: '2020-01-01', seed: 500 + k, volume: 1e9 * (1 + k / 10) };
    perp[spec.symbol] = plantedRows(spec, beta, lag);
    funding[spec.symbol] = syntheticFunding({ ...spec, volume: spec.volume }, perp[spec.symbol]);
  }
  return universeFromRows(perp, funding, {
    universe: { from: '2021-01-01', to: '2026-07-01', minBars: 366, topN: count, minEligibleToStart: 10 },
    basket: { from: '2020-02-01', to: '2026-07-01', minBars: 30, topN: count, minEligibleToStart: 0 },
  });
}

/**
 * `count` contracts with staggered listings (2020-01-01 to about 2024), about one in eight delisting, a few
 * halts, the top 50 as members: the wall-time estimate's universe.
 */
export function largeFlowSpecs(count: number): SyntheticSpec[] {
  const random = createSeededRandom(4242);
  const specs: SyntheticSpec[] = [];
  for (let k = 0; k < count; k++) {
    const startOffset = k < 40 ? 0 : Math.floor(random() * 1500);
    const start = new Date(Date.UTC(2020, 0, 1) + startOffset * DAY_MS).toISOString().slice(0, 10);
    const delists = k >= 20 && random() < 0.125;
    const life = 400 + Math.floor(random() * 1200);
    const endMs = Date.UTC(2020, 0, 1) + (startOffset + life) * DAY_MS;
    const end = delists && endMs < Date.UTC(2026, 5, 20) ? new Date(endMs).toISOString().slice(0, 10) : undefined;
    const halted = random() < 0.05 ? [200, 201, 202] : undefined;
    specs.push({
      symbol: `X${String(k).padStart(3, '0')}USDT`,
      start,
      end,
      seed: 9000 + k,
      volume: 1e10 / (1 + k * (0.5 + random())),
      vol: 0.03 + 0.05 * random(),
      halted,
    });
  }
  return specs;
}
