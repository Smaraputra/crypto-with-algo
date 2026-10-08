import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TEMPLATE_WEIGHTS } from '@/lib/models/signal-template';
import { computeIndicatorsForStyle } from '@/lib/indicators/compute-for-style';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import { computeSignalScore } from '@/lib/signals/scorer';
import { computeHtfSeries, htfContextAtBar } from '@/lib/signals/htf';
import type { OHLCV } from '@/types/market';
import type { FuturesData } from '@/types/futures';
import {
  buildSnapshotSeries,
  LS_Z_WARMUP_MS,
  type LeanSnapshot,
} from '@/lib/backtest/snapshot-series';
import {
  buildCandles,
  buildSnapshotRows,
  FIXED_NOW,
  FIXTURE_FEAR_GREED,
  lastClosedOpenTime,
  seedFor,
} from '@/__fixtures__/scoring-fixture';
import { scoreBar } from './score-bar';
import { htfContextFromClosed } from './scoring-inputs';

const STYLE = 'day_trading' as const;
const profile = getStyleConfig(STYLE);

function candles(interval: string, count: number) {
  return buildCandles({
    symbol: 'BTCUSDT',
    interval,
    count,
    endOpenTime: lastClosedOpenTime(interval),
    seed: seedFor('score-bar', interval),
    startPrice: 60000,
  });
}

const sentiment = { ...FIXTURE_FEAR_GREED, news: { count: 8, avgSentiment: 0.42 } };
function fixtureFutures(bars: OHLCV[]): FuturesData {
  const rows = buildSnapshotRows({
    symbol: 'BTCUSDT',
    snapshotInterval: '1h',
    from: FIXED_NOW - LS_Z_WARMUP_MS - 5 * 24 * 3_600_000,
    to: FIXED_NOW,
    seed: seedFor('score-bar', 'snapshots'),
  });
  const [bar] = buildSnapshotSeries([bars[bars.length - 1]], rows as unknown as LeanSnapshot[], '1h', {
    symbol: 'BTCUSDT',
  });
  if (!bar?.futures) throw new Error('fixture futures missing');
  return bar.futures;
}

describe('scoreBar', () => {
  const bars = candles('1h', profile.recommendedCandles);
  const futures = fixtureFutures(bars);
  const htfClosed = candles('4h', profile.recommendedCandles);
  const htfContext = htfContextFromClosed(htfClosed, '4h', profile.config);
  const weights = DEFAULT_TEMPLATE_WEIGHTS[STYLE];

  // computeSignalScore stamps Date.now(); freeze it so whole objects compare.
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('equals the three-call pipeline run by hand', () => {
    const expected = computeSignalScore(
      computeIndicatorsForStyle(bars, 'BTCUSDT', '1h', STYLE),
      futures,
      sentiment,
      weights,
      computeSuperTrend(bars),
      htfContext
    );
    const actual = scoreBar({
      candles: bars,
      symbol: 'BTCUSDT',
      interval: '1h',
      style: STYLE,
      futures,
      sentiment,
      weights,
      htfContext,
    });
    expect(actual).toEqual(expected);
    expect(actual.score).toBe(expected.score);
    expect(actual.tier).toBe(expected.tier);
    expect(actual.confidence).toBe(expected.confidence);
    expect(actual.components).toEqual(expected.components);
    expect(htfContext).not.toBeNull();
  });

  it('scores without futures, sentiment or HTF context', () => {
    const signal = scoreBar({
      candles: bars,
      symbol: 'BTCUSDT',
      interval: '1h',
      style: STYLE,
      futures: null,
      sentiment: null,
      weights,
      htfContext: null,
    });
    expect(Number.isFinite(signal.score)).toBe(true);
  });
});

describe('htfContextFromClosed', () => {
  it('returns null for an empty array', () => {
    expect(htfContextFromClosed([], '4h', profile.config)).toBeNull();
  });

  it('equals the hand pipeline for a non-empty array', () => {
    const closed = candles('4h', profile.recommendedCandles);
    const expected = htfContextAtBar(computeHtfSeries(closed, profile.config), closed.length - 1, '4h');
    expect(htfContextFromClosed(closed, '4h', profile.config)).toEqual(expected);
  });
});
