import { HistoricalSnapshot, type IHistoricalSnapshot } from './models/historical-snapshot';
import { SIGNAL_SYMBOLS } from './signals/signal-symbols';
import { LS_Z_WARMUP_MS, mapToSnapshotInterval, type LeanSnapshot } from './backtest/snapshot-series';

/**
 * Align timestamp to interval boundary (candle close time)
 */
export function alignTimestamp(timestamp: number, interval: string): number {
  const ms = timestamp;
  let intervalMs = 0;

  switch (interval) {
    case '1m':
      intervalMs = 60 * 1000;
      break;
    case '5m':
      intervalMs = 5 * 60 * 1000;
      break;
    case '15m':
      intervalMs = 15 * 60 * 1000;
      break;
    case '1h':
      intervalMs = 60 * 60 * 1000;
      break;
    case '4h':
      intervalMs = 4 * 60 * 60 * 1000;
      break;
    case '1d':
      intervalMs = 24 * 60 * 60 * 1000;
      break;
    default:
      throw new Error(`Unknown interval: ${interval}`);
  }

  return Math.floor(ms / intervalMs) * intervalMs;
}

/**
 * Get active symbols for snapshot ingestion
 */
export async function getActiveSymbols(): Promise<string[]> {
  return [...SIGNAL_SYMBOLS];
}

/**
 * Query historical snapshots for backtesting
 */
export async function getHistoricalSnapshots(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number
): Promise<IHistoricalSnapshot[]> {
  return await HistoricalSnapshot.find({
    symbol,
    interval,
    timestamp: { $gte: startTime, $lte: endTime },
  })
    .sort({ timestamp: 1 })
    .lean();
}

/**
 * Everything a SCORING path needs from stored snapshots for candles in
 * `[startTime, endTime]` (scorer configVersion 8): the rows at the candle
 * interval's snapshot interval, and, when that is coarser than 1h, the 1h rows
 * the L/S z is computed on (`buildSnapshotSeries`'s `lsRows1h`). Both start
 * `LS_Z_WARMUP_MS` early, so the first candle's z already has its thirty days.
 * `lsRows1h` is undefined at 1h and finer, where the snapshot rows are the 1h
 * rows.
 */
export async function getScoringSnapshots(
  symbol: string,
  candleInterval: string,
  startTime: number,
  endTime: number
): Promise<{ snapshots: LeanSnapshot[]; lsRows1h: LeanSnapshot[] | undefined }> {
  const snapshotInterval = mapToSnapshotInterval(candleInterval);
  const from = startTime - LS_Z_WARMUP_MS;
  const [snapshots, lsRows1h] = await Promise.all([
    getHistoricalSnapshots(symbol, snapshotInterval, from, endTime),
    snapshotInterval === '1h' ? Promise.resolve(undefined) : getHistoricalSnapshots(symbol, '1h', from, endTime),
  ]);
  return { snapshots, lsRows1h };
}

/**
 * Upsert a single snapshot (used by ingestion cron)
 */
export async function upsertSnapshot(
  symbol: string,
  interval: string,
  timestamp: number,
  data: IHistoricalSnapshot['data']
): Promise<void> {
  await HistoricalSnapshot.updateOne(
    { symbol, interval, timestamp },
    mergeSnapshotUpdate({ symbol, interval, timestamp, data }),
    { upsert: true }
  );
}

/**
 * Update document that merges data fields into an existing snapshot.
 *
 * Setting `data` as a whole replaced every field the writer did not supply. The
 * admin backfill supplies only funding, long/short, open interest, and Fear &
 * Greed, so running it erased the live-captured newsSentiment on up to 500
 * recent bars per symbol and interval, which cannot be re-fetched. Each field is
 * therefore set by its own path, and fields absent from this write are kept.
 */
function mergeSnapshotUpdate(snapshot: {
  symbol: string;
  interval: string;
  timestamp: number;
  data: IHistoricalSnapshot['data'];
}) {
  const { symbol, interval, timestamp, data } = snapshot;
  const $set: Record<string, unknown> = { symbol, interval, timestamp };

  for (const [field, value] of Object.entries(data ?? {})) {
    if (value !== undefined) {
      $set[`data.${field}`] = value;
    }
  }

  // With nothing to merge, a new document still gets an empty data object.
  // It cannot go in $set alongside data.* paths, which would conflict.
  const hasFields = Object.keys($set).length > 3;
  return hasFields ? { $set } : { $set, $setOnInsert: { data: {} } };
}

/**
 * Bulk upsert snapshots (used by backfill script)
 */
export async function bulkUpsertSnapshots(
  snapshots: Array<{
    symbol: string;
    interval: string;
    timestamp: number;
    data: IHistoricalSnapshot['data'];
  }>
): Promise<void> {
  if (snapshots.length === 0) return;

  const operations = snapshots.map((snapshot) => ({
    updateOne: {
      filter: { symbol: snapshot.symbol, interval: snapshot.interval, timestamp: snapshot.timestamp },
      update: mergeSnapshotUpdate(snapshot),
      upsert: true,
    },
  }));

  await HistoricalSnapshot.bulkWrite(operations);
}

/**
 * Get snapshot count (for monitoring)
 */
export async function getSnapshotStats(): Promise<{
  totalCount: number;
  bySymbol: Record<string, number>;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
}> {
  const total = await HistoricalSnapshot.countDocuments();

  const bySymbol = await HistoricalSnapshot.aggregate([
    { $group: { _id: '$symbol', count: { $sum: 1 } } },
  ]);

  const oldest = await HistoricalSnapshot.findOne().sort({ timestamp: 1 });
  const newest = await HistoricalSnapshot.findOne().sort({ timestamp: -1 });

  return {
    totalCount: total,
    bySymbol: Object.fromEntries(bySymbol.map((b) => [b._id, b.count])),
    oldestTimestamp: oldest?.timestamp ?? null,
    newestTimestamp: newest?.timestamp ?? null,
  };
}
