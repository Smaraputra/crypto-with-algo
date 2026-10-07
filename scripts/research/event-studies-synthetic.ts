/**
 * Synthetic hourly perp, 5m metrics and funding rows for testing the event studies harness (event-studies.ts)
 * without touching a real export. Deterministic for a seed. Nothing here is ever read by a real run.
 */
import { createSeededRandom } from '@/lib/stats/seeded-random';
import type { FundingRow, MetricsRow, PerpCandleRow } from './dataset-format';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Planted volume shocks: a volume spike at a fixed hour, followed by a one-hour reversal. */
export interface PlantedE3 {
  from: number;
  /** Exclusive. */
  to: number;
  /** Symbol i spikes on the days where (day number + i) % everyDays === 0. */
  everyDays: number;
  hourOfDay: number;
  /** The spike hour's |log return|; its sign is random. */
  move: number;
  /** The next hour's log return, against the spike hour's sign. */
  reversal: number;
  spikeVolume: number;
}

export interface SyntheticOptions {
  /** First hour, hour-aligned. */
  from: number;
  /** Exclusive. */
  to: number;
  seed: number;
  /** Hourly log-return standard deviation (default 0.003). */
  sigma?: number;
  /** Minutes past the hour of each metrics row (default 0, 30, 55). */
  metricsMinutes?: readonly number[];
  fundingEveryHours?: number;
  plantE3?: PlantedE3;
}

export interface SyntheticSymbol {
  symbol: string;
  klines: PerpCandleRow[];
  metrics: MetricsRow[];
  funding: FundingRow[];
}

function gaussian(random: () => number): () => number {
  return () => {
    const u = Math.max(random(), 1e-12);
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

export function syntheticSymbol(symbol: string, index: number, opts: SyntheticOptions): SyntheticSymbol {
  const random = createSeededRandom(opts.seed + index * 7_919);
  const normal = gaussian(random);
  const sigma = opts.sigma ?? 0.003;
  const n = Math.floor((opts.to - opts.from) / HOUR);
  const r = new Float64Array(n);
  const volume = new Float64Array(n);
  for (let h = 0; h < n; h++) {
    r[h] = sigma * normal();
    volume[h] = 1_000 * (1 + 0.5 * random());
  }

  const plant = opts.plantE3;
  if (plant) {
    for (let day = Math.ceil(plant.from / DAY) * DAY; day < plant.to; day += DAY) {
      if ((Math.floor(day / DAY) + index) % plant.everyDays !== 0) continue;
      const h = (day + plant.hourOfDay * HOUR - opts.from) / HOUR;
      if (h < 0 || h + 1 >= n) continue;
      const sign = random() < 0.5 ? -1 : 1;
      volume[h] = plant.spikeVolume;
      r[h] = sign * plant.move;
      r[h + 1] = -sign * plant.reversal;
    }
  }

  const klines: PerpCandleRow[] = [];
  let price = 100;
  for (let h = 0; h < n; h++) {
    const o = price;
    const c = o * Math.exp(r[h]);
    price = c;
    klines.push({
      t: opts.from + h * HOUR,
      o,
      h: Math.max(o, c),
      l: Math.min(o, c),
      c,
      v: volume[h],
      qv: volume[h] * c,
      n: 100,
      tbv: null,
    });
  }

  const minutes = opts.metricsMinutes ?? [0, 30, 55];
  const metrics: MetricsRow[] = [];
  let oi = 1_000_000;
  for (let h = 0; h < n; h++) {
    for (const minute of minutes) {
      oi *= Math.exp(0.002 * normal());
      metrics.push({
        t: opts.from + h * HOUR + minute * 60_000,
        openInterest: oi,
        openInterestValue: null,
        topTraderAccountRatio: null,
        topTraderPositionRatio: null,
        globalAccountRatio: null,
        takerLongShortRatio: null,
        depthImbalance1: null,
        depthImbalance2: null,
        depthImbalance5: null,
        depthNotional1: null,
        depthNotional5: null,
      });
    }
  }

  const every = opts.fundingEveryHours ?? 8;
  const funding: FundingRow[] = [];
  const firstSettlement = Math.ceil(opts.from / (every * HOUR)) * every * HOUR;
  for (let t = firstSettlement; t < opts.to; t += every * HOUR) {
    funding.push({ t, rate: 0.0001 + 0.00005 * normal(), intervalHours: every });
  }

  return { symbol, klines, metrics, funding };
}

export function syntheticDataset(symbols: readonly string[], opts: SyntheticOptions): SyntheticSymbol[] {
  return symbols.map((symbol, i) => syntheticSymbol(symbol, i, opts));
}
