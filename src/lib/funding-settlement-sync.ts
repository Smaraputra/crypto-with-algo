import { connectDB } from '@/lib/mongodb';
import { FundingSettlement } from '@/lib/models/funding-settlement';
import { fetchFundingHistory } from '@/lib/snapshot-backfill';
import { settlementTimeOf } from '@/lib/funding-settlements';
import type { FundingRate } from '@/types/futures';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Look-back when a symbol has no stored settlement yet. */
const INITIAL_LOOKBACK_MS = 30 * DAY_MS;
/** Re-read this far behind the newest stored row so a late or corrected print is picked up. */
const OVERLAP_MS = DAY_MS;

export interface FundingSyncDeps {
  fetchFundingHistory: (symbol: string, startTime: number, endTime: number) => Promise<FundingRate[]>;
}

export interface FundingSyncResult {
  symbol: string;
  inserted: number;
  updated: number;
  error?: string;
}

/**
 * Upserts REST funding history into the settlement collection, keyed on
 * (symbol, fundingTime) with the REST time rounded to its boundary. New rows
 * are marked source 'rest'. An existing row (usually an archive row) keeps its
 * rate, interval and source: only a finite markPrice is ever written to it, and
 * a missing one (Binance returned "" for older history) never overwrites a
 * stored value. One failing symbol is recorded in its result and does not stop
 * the others.
 */
export async function syncFundingSettlements(
  symbols: string[],
  now: number,
  deps: FundingSyncDeps = { fetchFundingHistory }
): Promise<FundingSyncResult[]> {
  await connectDB();
  const results: FundingSyncResult[] = [];

  for (const symbol of symbols) {
    try {
      const newest = await FundingSettlement.findOne({ symbol }).sort({ fundingTime: -1 }).lean();
      const start = newest ? newest.fundingTime - OVERLAP_MS : now - INITIAL_LOOKBACK_MS;
      const events = await deps.fetchFundingHistory(symbol, start, now);

      const ops = events
        .filter((e) => Number.isFinite(e.fundingTime) && Number.isFinite(e.fundingRate))
        .map((e) => {
          const fundingTime = settlementTimeOf(e.fundingTime);
          const hasMark = Number.isFinite(e.markPrice);
          return {
            updateOne: {
              filter: { symbol, fundingTime },
              update: {
                $setOnInsert: {
                  rate: e.fundingRate,
                  rawTime: e.fundingTime,
                  intervalHours: null,
                  source: 'rest' as const,
                  ...(hasMark ? {} : { markPrice: null }),
                },
                ...(hasMark ? { $set: { markPrice: e.markPrice } } : {}),
              },
              upsert: true,
            },
          };
        });

      if (ops.length === 0) {
        results.push({ symbol, inserted: 0, updated: 0 });
        continue;
      }
      const res = await FundingSettlement.bulkWrite(ops, { ordered: false });
      results.push({ symbol, inserted: res.upsertedCount, updated: res.modifiedCount });
    } catch (err) {
      results.push({
        symbol,
        inserted: 0,
        updated: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
