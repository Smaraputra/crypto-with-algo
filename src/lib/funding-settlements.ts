import type { UpsertOp } from '@/lib/archive-ingestion';

const HOUR_MS = 3_600_000;

/** One parsed archive funding row (`parseFundingCsv` in binance-archive.ts). */
export interface FundingEvent {
  timestamp: number;
  intervalHours: number | null;
  rate: number;
}

export interface FundingSettlementFields {
  symbol: string;
  fundingTime: number;
  rawTime: number;
  rate: number;
  intervalHours: number | null;
}

/**
 * The settlement boundary an archive `calc_time` belongs to. The archive stamps
 * each settlement 1 ms after its boundary (`binance-archive.test.ts`), so the
 * nearest hour is the boundary.
 */
export function settlementTimeOf(calcTime: number): number {
  return Math.round(calcTime / HOUR_MS) * HOUR_MS;
}

/** Upserts keyed on (symbol, fundingTime), so re-ingesting a month is idempotent. */
export function fundingSettlementUpserts(
  symbol: string,
  events: FundingEvent[]
): UpsertOp<FundingSettlementFields>[] {
  const ops: UpsertOp<FundingSettlementFields>[] = [];
  for (const event of events) {
    if (!Number.isFinite(event.timestamp) || !Number.isFinite(event.rate)) continue;
    const fundingTime = settlementTimeOf(event.timestamp);
    ops.push({
      filter: { symbol, fundingTime },
      set: {
        symbol,
        fundingTime,
        rawTime: event.timestamp,
        rate: event.rate,
        intervalHours:
          event.intervalHours !== null && Number.isFinite(event.intervalHours) ? event.intervalHours : null,
      },
    });
  }
  return ops;
}

export interface SettlementRow {
  /** Settlement boundary, ms UTC. */
  t: number;
  rate: number;
  intervalHours: number | null;
}

export interface SpacingYearRow {
  year: number;
  settlements: number;
  /** Gaps to the next settlement that differ from this row's stated interval. */
  spacingMismatches: number;
  /** Gaps longer than the stated interval: settlements missing from the archive. */
  missingSpan: number;
  /** Rows where the stated interval differs from the previous row's. */
  intervalSwitches: number;
  /** Settlements per stated interval, e.g. { '8': 1093, '4': 2 }; 'null' when the column is empty. */
  byInterval: Record<string, number>;
  minRate: number;
  maxRate: number;
  /** Share of settlements at exactly the 0.01% base rate. */
  baseRateShare: number;
  /** Settlements whose |rate| equals the year's largest |rate|: a cap or floor shows up as a pile here. */
  atExtreme: number;
}

const BASE_RATE = 0.0001;

/**
 * Per calendar year (UTC) of one symbol's settlements: whether the gaps match
 * the stated interval, where the interval switched, and how the rate is
 * distributed. Rows must be sorted by `t`. A gap is attributed to the row it
 * starts from; the last row of the series has no gap.
 */
export function settlementSpacingReport(rows: SettlementRow[]): SpacingYearRow[] {
  const byYear = new Map<number, SpacingYearRow>();
  const rates = new Map<number, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const year = new Date(row.t).getUTCFullYear();
    let acc = byYear.get(year);
    if (!acc) {
      acc = {
        year,
        settlements: 0,
        spacingMismatches: 0,
        missingSpan: 0,
        intervalSwitches: 0,
        byInterval: {},
        minRate: Infinity,
        maxRate: -Infinity,
        baseRateShare: 0,
        atExtreme: 0,
      };
      byYear.set(year, acc);
      rates.set(year, []);
    }
    acc.settlements++;
    const key = row.intervalHours === null ? 'null' : String(row.intervalHours);
    acc.byInterval[key] = (acc.byInterval[key] ?? 0) + 1;
    acc.minRate = Math.min(acc.minRate, row.rate);
    acc.maxRate = Math.max(acc.maxRate, row.rate);
    rates.get(year)!.push(row.rate);
    if (i > 0 && rows[i - 1].intervalHours !== row.intervalHours) acc.intervalSwitches++;
    const next = rows[i + 1];
    if (next && row.intervalHours !== null) {
      const gap = next.t - row.t;
      const expected = row.intervalHours * HOUR_MS;
      if (gap !== expected) acc.spacingMismatches++;
      if (gap > expected) acc.missingSpan++;
    }
  }
  for (const [year, acc] of byYear) {
    const list = rates.get(year)!;
    const extreme = Math.max(...list.map((r) => Math.abs(r)));
    acc.atExtreme = list.filter((r) => Math.abs(r) === extreme).length;
    acc.baseRateShare = list.filter((r) => r === BASE_RATE).length / list.length;
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}
