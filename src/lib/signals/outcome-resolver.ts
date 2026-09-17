import type { Types } from 'mongoose';

import type { TradingStyle } from '@/lib/models/signal-template';
import type { SignalTier } from '@/types/signal';
import { SignalOutcome, type ISignalOutcome } from '@/lib/models/signal-outcome';
import { getCandles } from '@/lib/candle-ingestion';
import { intervalToMs } from '@/lib/intervals';
import { OUTCOME_HORIZON_BARS, resolveAtFor } from '@/lib/signals/outcome-horizons';

const DUPLICATE_KEY_ERROR_CODE = 11000;

export interface StoredSignalForOutcome {
  _id: Types.ObjectId | string;
  symbol: string;
  interval: string;
  tradingStyle: TradingStyle;
  tier: SignalTier;
  score: number;
  configVersion: number;
  candleTimestamp: number;
}

interface MongoWriteError {
  code?: number;
  err?: { code?: number };
}

interface MongoInsertManyError {
  code?: number;
  writeErrors?: MongoWriteError[];
  insertedDocs?: unknown[];
}

function writeErrorCode(we: MongoWriteError): number | undefined {
  return we.err?.code ?? we.code;
}

/** True when every failure in an insertMany error is a duplicate key error (11000). */
function isDuplicateKeyOnly(err: unknown): err is MongoInsertManyError {
  const error = err as MongoInsertManyError;
  if (error?.writeErrors && error.writeErrors.length > 0) {
    return error.writeErrors.every((we) => writeErrorCode(we) === DUPLICATE_KEY_ERROR_CODE);
  }
  return error?.code === DUPLICATE_KEY_ERROR_CODE;
}

/**
 * Record a pending outcome for each freshly stored signal so its prediction
 * can later be checked against what price actually did. Safe to call with
 * signals that already have an outcome (e.g. a retried batch): duplicate
 * signalId inserts are ignored and excluded from the returned count.
 */
export async function createPendingOutcomes(
  signals: StoredSignalForOutcome[]
): Promise<number> {
  if (signals.length === 0) return 0;

  const docs = signals.map((signal) => {
    const horizonBars = OUTCOME_HORIZON_BARS[signal.tradingStyle];
    return {
      signalId: signal._id,
      symbol: signal.symbol,
      interval: signal.interval,
      tradingStyle: signal.tradingStyle,
      tier: signal.tier,
      score: signal.score,
      configVersion: signal.configVersion,
      candleTimestamp: signal.candleTimestamp,
      horizonBars,
      resolveAt: resolveAtFor(signal.candleTimestamp, signal.interval, horizonBars),
    };
  });

  // Validate every document up front so a genuine schema problem (e.g. an
  // unknown tradingStyle) always throws. insertMany's own validation
  // handling is not enough: when a MongoDB-level write error (a duplicate
  // key on signalId) and a schema-invalid document occur in the same call,
  // the driver's write error is what insertMany throws, and it carries only
  // the duplicate-key code, mongoose never reaches its validation-error
  // reporting, and the real problem is silently dropped.
  for (const doc of docs) {
    const validationError = new SignalOutcome(doc).validateSync();
    if (validationError) throw validationError;
  }

  try {
    const inserted = await SignalOutcome.insertMany(docs, { ordered: false });
    return inserted.length;
  } catch (err) {
    if (isDuplicateKeyOnly(err)) {
      return err.insertedDocs?.length ?? 0;
    }
    throw err;
  }
}

export interface ResolveDueOutcomesResult {
  resolved: number;
  unresolvable: number;
  pending: number;
}

type PendingOutcome = ISignalOutcome & { _id: Types.ObjectId };

/**
 * Resolve every pending outcome whose horizon has elapsed by looking up the
 * entry candle and the following horizonBars candles from stored candle
 * data. Candles are fetched once per (symbol, interval) group covering the
 * whole batch to avoid redundant reads.
 */
export async function resolveDueOutcomes(
  now: number = Date.now(),
  batchSize = 500
): Promise<ResolveDueOutcomesResult> {
  const due: PendingOutcome[] = await SignalOutcome.find({
    status: 'pending',
    resolveAt: { $lte: now },
  })
    .sort({ resolveAt: 1 })
    .limit(batchSize)
    .lean();

  if (due.length === 0) {
    const pending = await SignalOutcome.countDocuments({ status: 'pending' });
    return { resolved: 0, unresolvable: 0, pending };
  }

  const groups = new Map<string, PendingOutcome[]>();
  for (const outcome of due) {
    const key = `${outcome.symbol}:${outcome.interval}`;
    const group = groups.get(key);
    if (group) {
      group.push(outcome);
    } else {
      groups.set(key, [outcome]);
    }
  }

  const resolvedOps: Array<{
    updateOne: {
      filter: { _id: Types.ObjectId };
      update: { $set: Record<string, unknown> };
    };
  }> = [];

  for (const [key, outcomes] of groups) {
    const [symbol, interval] = key.split(':');
    const intervalMs = intervalToMs(interval);

    const minTimestamp = Math.min(...outcomes.map((o) => o.candleTimestamp));
    const maxResolveAt = Math.max(...outcomes.map((o) => o.resolveAt));
    const candleLimit = Math.ceil((maxResolveAt - minTimestamp) / intervalMs) + 2;

    const candles = await getCandles(symbol, interval, minTimestamp, maxResolveAt, candleLimit);
    const indexByTimestamp = new Map<number, number>();
    candles.forEach((c, i) => indexByTimestamp.set(c.timestamp, i));

    for (const outcome of outcomes) {
      const entryIndex = indexByTimestamp.get(outcome.candleTimestamp);

      if (entryIndex === undefined) {
        resolvedOps.push(unresolvableOp(outcome._id, now));
        continue;
      }

      const entry = candles[entryIndex];
      const forwardCandles = candles.slice(
        entryIndex + 1,
        entryIndex + 1 + outcome.horizonBars
      );

      if (forwardCandles.length < outcome.horizonBars) {
        resolvedOps.push(unresolvableOp(outcome._id, now));
        continue;
      }

      const consecutive = forwardCandles.every(
        (candle, i) => candle.timestamp === outcome.candleTimestamp + (i + 1) * intervalMs
      );
      if (!consecutive) {
        resolvedOps.push(unresolvableOp(outcome._id, now));
        continue;
      }

      const entryPrice = entry.close;
      const exitCandle = forwardCandles[forwardCandles.length - 1];
      const forwardReturnPercent = ((exitCandle.close - entryPrice) / entryPrice) * 100;
      const maxHigh = Math.max(...forwardCandles.map((c) => c.high));
      const minLow = Math.min(...forwardCandles.map((c) => c.low));
      const mfePercent = ((maxHigh - entryPrice) / entryPrice) * 100;
      const maePercent = ((minLow - entryPrice) / entryPrice) * 100;

      resolvedOps.push({
        updateOne: {
          filter: { _id: outcome._id },
          update: {
            $set: {
              status: 'resolved',
              entryPrice,
              forwardReturnPercent,
              mfePercent,
              maePercent,
              resolvedAt: new Date(now),
            },
          },
        },
      });
    }
  }

  if (resolvedOps.length > 0) {
    await SignalOutcome.bulkWrite(resolvedOps);
  }

  const resolved = resolvedOps.filter((op) => op.updateOne.update.$set.status === 'resolved').length;
  const unresolvable = resolvedOps.length - resolved;
  const pending = await SignalOutcome.countDocuments({ status: 'pending' });

  return { resolved, unresolvable, pending };
}

function unresolvableOp(id: Types.ObjectId, now: number) {
  return {
    updateOne: {
      filter: { _id: id },
      update: {
        $set: {
          status: 'unresolvable' as const,
          resolvedAt: new Date(now),
        },
      },
    },
  };
}
