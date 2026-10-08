/**
 * Synthetic broad-phase universes for the tests and the wall-time estimate: seeded
 * random walks with regime drifts, volumes for the ranking, halts, delistings and
 * funding settlements. No real data is read.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSeededRandom } from '@/lib/stats/seeded-random';
import { buildBroadInputs, type BroadInputs } from './broad-inputs';
import { DAY_MS, dayStartMs, segmentContracts, universeFile, type MembershipOptions, type UniverseFile } from './broad-trend';
import {
  LOCKBOX_START_ISO,
  datasetHashOf,
  sha256File,
  writeJsonlGz,
  type DatasetManifest,
  type FundingRow,
  type ManifestFile,
  type PerpCandleRow,
} from './dataset-format';

export interface SyntheticSpec {
  symbol: string;
  /** First bar day. */
  start: string;
  /** Last bar day, inclusive; default 2026-06-30. */
  end?: string;
  seed: number;
  /** Quote volume level: the ranking reads its median. */
  volume: number;
  /** Daily standard deviation of returns; default 0.04. */
  vol?: number;
  /** Mean daily drift; each 120-day regime adds +-2x vol / 10. Default 0. */
  drift?: number;
  price?: number;
  /** Day offsets printed with zero volume (missing days for every rule). */
  halted?: readonly number[];
  /** Funding interval in hours; default 8. */
  intervalHours?: number;
  /** Settlement times left out of the archive. */
  dropSettlements?: readonly number[];
}

/** A spec's daily perp bars (halted days at zero volume and a flat price, as the archive prints them). */
export function syntheticRows(spec: SyntheticSpec): PerpCandleRow[] {
  const random = createSeededRandom(spec.seed);
  const from = dayStartMs(spec.start);
  const to = dayStartMs(spec.end ?? '2026-06-30');
  const vol = spec.vol ?? 0.04;
  const halted = new Set(spec.halted ?? []);
  const rows: PerpCandleRow[] = [];
  let c = spec.price ?? 100;
  let regime = 0;
  for (let k = 0, t = from; t <= to; k++, t += DAY_MS) {
    if (k % 120 === 0) regime = (random() < 0.5 ? -1 : 1) * 0.2 * vol;
    const z = Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());
    const o = c;
    if (halted.has(k)) {
      rows.push({ t, o: c, h: c, l: c, c, v: 0, qv: 0, n: 0, tbv: null });
      continue;
    }
    c = Math.max(1e-6, c * (1 + (spec.drift ?? 0) + regime + vol * z));
    const qv = spec.volume * (0.8 + 0.4 * random());
    rows.push({ t, o, h: Math.max(o, c), l: Math.min(o, c), c, v: qv / c, qv, n: 100, tbv: null });
  }
  return rows;
}

/** Settlements every `intervalHours` from the first bar day to the last bar day + 1 day, before the lockbox. */
export function syntheticFunding(spec: SyntheticSpec, rows: readonly PerpCandleRow[]): FundingRow[] {
  const h = spec.intervalHours ?? 8;
  const dropped = new Set(spec.dropSettlements ?? []);
  const out: FundingRow[] = [];
  if (rows.length === 0) return out;
  const last = Math.min(rows[rows.length - 1].t + DAY_MS, Date.UTC(2026, 6, 1) - 1);
  for (let t = rows[0].t + h * 3_600_000, k = 0; t <= last; t += h * 3_600_000, k++) {
    if (!dropped.has(t)) out.push({ t, rate: 0.0001 * (1 + 0.5 * Math.sin(k / 10)), intervalHours: h });
  }
  return out;
}

export interface SyntheticUniverse {
  datasetHash: string;
  perp: Record<string, PerpCandleRow[]>;
  funding: Record<string, FundingRow[]>;
  universe: UniverseFile;
}

export interface SyntheticOptions {
  universe: MembershipOptions;
  basket: MembershipOptions;
}

/** A small universe: six members from the 2021-01-01 close, the basket (eight) from 2020-02-01. */
export const SMALL_OPTIONS: SyntheticOptions = {
  universe: { from: '2021-01-01', to: '2026-07-01', minBars: 366, topN: 6, minEligibleToStart: 2 },
  basket: { from: '2020-02-01', to: '2026-07-01', minBars: 30, topN: 8, minEligibleToStart: 0 },
};

/**
 * Eight contracts: BTC, ETH and SOL (legends assets), a fading alt, a delisting
 * (BBB, 2023-05-10), a 3-day halt inside a contract (CCC), a 10-day halt that splits
 * DDD into two contracts, and a 4-hour funding interval (EEE).
 */
export const SMALL_SPECS: SyntheticSpec[] = [
  { symbol: 'BTCUSDT', start: '2020-01-01', seed: 1, volume: 1e10, vol: 0.035, drift: 0.0008 },
  { symbol: 'ETHUSDT', start: '2020-01-01', seed: 2, volume: 5e9, vol: 0.045, drift: 0.0008 },
  { symbol: 'SOLUSDT', start: '2020-09-14', seed: 3, volume: 1e9, vol: 0.06, drift: 0.001 },
  { symbol: 'AAAUSDT', start: '2020-01-01', seed: 4, volume: 3e8, vol: 0.05, drift: -0.0008 },
  { symbol: 'BBBUSDT', start: '2020-06-01', end: '2023-05-10', seed: 5, volume: 2e8, vol: 0.06 },
  { symbol: 'CCCUSDT', start: '2021-03-01', seed: 6, volume: 3.08e8, vol: 0.05, halted: [900, 901, 902] },
  { symbol: 'DDDUSDT', start: '2021-09-01', seed: 7, volume: 1.95e8, vol: 0.07, halted: [950, 951, 952, 953, 954, 955, 956, 957, 958, 959] },
  { symbol: 'EEEUSDT', start: '2022-02-01', seed: 8, volume: 1e8, vol: 0.06, intervalHours: 4 },
];

export function syntheticUniverse(
  specs: readonly SyntheticSpec[] = SMALL_SPECS,
  options: SyntheticOptions = SMALL_OPTIONS,
  datasetHash = 'synthetic-export'
): SyntheticUniverse {
  const perp: Record<string, PerpCandleRow[]> = {};
  const funding: Record<string, FundingRow[]> = {};
  for (const spec of specs) {
    perp[spec.symbol] = syntheticRows(spec);
    funding[spec.symbol] = syntheticFunding(spec, perp[spec.symbol]);
  }
  const contracts = specs.flatMap((spec) => segmentContracts(spec.symbol, perp[spec.symbol]));
  const universe = universeFile({ sourceDatasetHash: datasetHash, contracts, universe: options.universe, basket: options.basket });
  return { datasetHash, perp, funding, universe };
}

/** buildBroadInputs over a synthetic universe held in memory. */
export function syntheticBroadInputs(u: SyntheticUniverse = syntheticUniverse()): BroadInputs {
  return buildBroadInputs({
    datasetHash: u.datasetHash,
    universe: u.universe,
    perp: (symbol) => ({ rows: u.perp[symbol] ?? [], lockboxApplied: true }),
    funding: (symbol) => ({ rows: u.funding[symbol] ?? [], lockboxApplied: true }),
  });
}

/**
 * Writes a synthetic universe as an export directory (perp 1d klines and funding
 * settlements per symbol, a manifest with every file's sha256 and the dataset hash)
 * and returns the dataset hash. The universe file must then be rebuilt with it.
 */
export async function writeSyntheticExport(dir: string, u: SyntheticUniverse): Promise<string> {
  const files: ManifestFile[] = [];
  for (const symbol of Object.keys(u.perp).sort()) {
    const perpPath = join('perp', symbol, '1d.jsonl.gz');
    await writeJsonlGz(join(dir, perpPath), u.perp[symbol]);
    const fundingPath = join('funding', symbol, 'settlements.jsonl.gz');
    await writeJsonlGz(join(dir, fundingPath), u.funding[symbol]);
    for (const [path, kind, interval, rows] of [
      [perpPath, 'perp', '1d', u.perp[symbol]],
      [fundingPath, 'funding', '8h', u.funding[symbol]],
    ] as const) {
      files.push({
        path,
        kind,
        symbol,
        interval,
        rowCount: rows.length,
        startMs: rows[0]?.t ?? null,
        endMs: rows[rows.length - 1]?.t ?? null,
        sha256: await sha256File(join(dir, path)),
      });
    }
  }
  const manifest: DatasetManifest = {
    version: 1,
    generatedAt: '2026-10-07T00:00:00.000Z',
    commit: 'synthetic',
    lockboxStart: LOCKBOX_START_ISO,
    symbols: Object.keys(u.perp).sort(),
    intervals: ['1d'],
    files,
    datasetHash: datasetHashOf(files),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest.datasetHash;
}
