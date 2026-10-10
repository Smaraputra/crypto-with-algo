import { z } from 'zod';

import { TRADING_STYLES } from '@/lib/indicators/style-configs';
import type { TradingStyle } from '@/lib/models/signal-template';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

/**
 * Shape of a stored re-score run. The loader parses what it is about to write
 * and the route parses what it read, so the Mixed `cells` field of
 * SignalRescoreRun can never hand the client a malformed record. Zod drops
 * undeclared keys silently, so every field of the types in ./types.ts is
 * declared here.
 */

const rate = z.number().min(0).max(1).nullable();
const finite = z.number().finite();

export const pointMeasuresSchema = z.object({
  calls: z.number().int().min(0),
  buyN: z.number().int().min(0),
  sellN: z.number().int().min(0),
  buyHit: rate,
  sellHit: rate,
  bh: rate,
  right: rate,
  meanBefore: finite.nullable(),
  net: finite.nullable(),
  wonAfterCost: rate,
  avgWin: finite.nullable(),
  avgLoss: finite.nullable(),
  breakEven: finite.nullable(),
});

const intervalPair = z.object({ lo: finite, hi: finite }).nullable();

export const symbolTrackSchema = z.object({
  symbol: z.string().min(1),
  first: z.number().int(),
  last: z.number().int(),
  liveSince: z.number().int().nullable(),
  measures: pointMeasuresSchema,
  intervals: z.object({ right: intervalPair, bh: intervalPair, net: intervalPair }),
  months: z.array(
    z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/),
      calls: z.number().int().min(0),
      right: rate,
      bh: rate,
      net: finite.nullable(),
    })
  ),
});

export const cellTrackSchema = z.object({
  style: z.enum(TRADING_STYLES as [TradingStyle, ...TradingStyle[]]),
  interval: z.string().min(1),
  horizonBars: z.number().int().positive(),
  costPercent: z.number().positive(),
  pooled: z.object({
    rows: z.number().int().min(0),
    buyN: z.number().int().min(0),
    sellN: z.number().int().min(0),
    bh: finite,
    bhLo: finite,
    bhHi: finite,
    net: finite,
    netLo: finite,
    netHi: finite,
    spearman: finite,
    level: z.number().gt(0).lt(1),
    verdict: z.string().min(1),
  }),
  parity: z.object({
    matched: z.number().int().min(0),
    sameTierShare: rate,
    scoreCorrelation: finite.nullable(),
  }),
  symbols: z.array(symbolTrackSchema),
});

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const trackRunSchema = z.object({
  runId: z.string().min(1),
  configVersion: z.number().int().positive(),
  windowStart: z.string().min(1),
  windowEnd: z.string().min(1),
  cutoffs: z.object({ buy: z.number().positive(), strong: z.number().positive() }),
  rowsSha256: sha256,
  reportSha256: sha256,
  gitCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
  resamples: z.number().int().positive(),
  seed: z.number().int(),
  loadedAt: z.string().min(1),
  cells: z.array(cellTrackSchema),
});

/** Query of both track-record routes: a signal symbol, a style and an interval (the cell is checked after). */
export const trackQuerySchema = z.object({
  symbol: z.enum(SIGNAL_SYMBOLS, { error: 'symbol must be a signal symbol.' }),
  style: z.enum(TRADING_STYLES as [TradingStyle, ...TradingStyle[]], {
    error: 'style must be one of the four trading styles.',
  }),
  interval: z.string({ error: 'interval is required.' }).min(1),
});
