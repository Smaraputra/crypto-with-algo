import type { CandleRow, FundingRow, PerpCandleRow, SnapshotRow } from './dataset-format';
import { DAY_MS } from './trend-signals';
import { CONSISTENCY_FROM, buildSettlements, splicedInput, type TrendInputs } from './trend-harness';
import type { TrendSymbolInput } from './trend-sim';

/** Synthetic trend-container fixtures shared by the harness and golden tests. */

export function snapshot(t: number, rate: number | null): SnapshotRow {
  return {
    t,
    fundingRate: rate === null ? null : { rate, markPrice: null },
    longShortRatio: null,
    openInterest: null,
    fearGreed: null,
    newsSentiment: null,
  } as unknown as SnapshotRow;
}

/** A seeded random walk of daily bars. */
export function walk(seed: number, from: number, to: number, scale = 1): CandleRow[] {
  let s = seed;
  const rows: CandleRow[] = [];
  let c = 100 * scale;
  for (let t = from; t < to; t += DAY_MS) {
    s = (s * 16807) % 2147483647;
    const o = c;
    c = c * (1 + (s / 2147483647 - 0.49) * 0.06);
    rows.push({ t, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1, tbv: null });
  }
  return rows;
}

export function syntheticInputs(): TrendInputs {
  const from = Date.UTC(2018, 10, 1);
  const to = Date.UTC(2026, 6, 1);
  const listings = [Date.UTC(2019, 8, 11), Date.UTC(2019, 10, 28), Date.UTC(2020, 8, 23)];
  const primary: TrendSymbolInput[] = [];
  const perp: TrendSymbolInput[] = [];
  const fallback: Record<string, number> = {};
  const filledDays: Record<string, { primary: number; perp: number }> = {};
  listings.forEach((listing, k) => {
    const symbol = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'][k];
    const spot = walk(11 + k, from, to);
    const perpRows: PerpCandleRow[] = spot
      .filter((r) => r.t >= CONSISTENCY_FROM)
      .map((r) => ({ ...r, o: r.o * 1.0005, c: r.c * 1.0005, qv: 0, n: 0 }));
    const archive: FundingRow[] = [];
    for (let t = Date.UTC(2020, 0, 1); t < to; t += 8 * 3_600_000) archive.push({ t, rate: 0.0001, intervalHours: 8 });
    const snaps = [snapshot(Date.UTC(2019, 8, 10, 8), 0.0001)];
    const { settlements, fallback: count } = buildSettlements(listing, archive, snaps);
    fallback[symbol] = count;
    primary.push(splicedInput(symbol, spot, [], to, listing, settlements).input);
    perp.push(splicedInput(symbol, spot, perpRows, CONSISTENCY_FROM, listing, settlements).input);
    filledDays[symbol] = { primary: 0, perp: 0 };
  });
  return { primary, perp, fallback, filledDays, lockboxApplied: true };
}
