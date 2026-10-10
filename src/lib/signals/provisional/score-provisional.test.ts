import { describe, expect, it } from 'vitest';

import { buildCandles, FIXED_NOW, lastClosedOpenTime, seedFor } from '@/__fixtures__/scoring-fixture';
import { DEFAULT_TEMPLATE_WEIGHTS } from '@/lib/models/signal-template';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import { intervalToMs } from '@/lib/intervals';
import { SCORER_CONFIG_VERSION } from '@/lib/signals/config-version';
import { scoreBar } from '@/lib/signals/score-bar';
import { scoreProvisional } from './score-provisional';
import type { FormingBar, ProvisionalContextReady } from './types';

const interval = '1h';
const style = 'day_trading' as const;
const forming = lastClosedOpenTime(interval) + intervalToMs(interval);
const rec = getStyleConfig(style).recommendedCandles;

const closedCandles = buildCandles({
  symbol: 'BTCUSDT',
  interval,
  count: rec - 1,
  endOpenTime: forming - intervalToMs(interval),
  seed: seedFor('candles', 'BTCUSDT', interval),
  startPrice: 60000,
});

const ctx: ProvisionalContextReady = {
  ready: true,
  configVersion: SCORER_CONFIG_VERSION,
  symbol: 'BTCUSDT',
  interval,
  style,
  formingOpenTime: forming,
  closedCandles,
  futures: null,
  sentiment: { fearGreedIndex: 27, label: 'Fear', news: { count: 8, avgSentiment: 0.4 } },
  weights: DEFAULT_TEMPLATE_WEIGHTS[style],
  htfContext: null,
  generatedAt: FIXED_NOW,
};

const bar: FormingBar = {
  openTime: forming,
  open: 61000,
  high: 61400,
  low: 60900,
  close: 61300,
  volume: 321,
  takerBuyVolume: 180,
};

describe('scoreProvisional', () => {
  it('returns null when the bar is not the one the context was built for', () => {
    expect(scoreProvisional(ctx, { ...bar, openTime: forming + intervalToMs(interval) })).toBeNull();
    expect(scoreProvisional(ctx, { ...bar, openTime: forming - 1 })).toBeNull();
  });

  it.each(['open', 'high', 'low', 'close', 'volume', 'takerBuyVolume'] as const)(
    'returns null when %s is not finite',
    (field) => {
      expect(scoreProvisional(ctx, { ...bar, [field]: Number.NaN })).toBeNull();
      expect(scoreProvisional(ctx, { ...bar, [field]: Number.POSITIVE_INFINITY })).toBeNull();
    }
  );

  it('equals scoreBar on the closed window plus the forming bar', () => {
    const expected = scoreBar({
      candles: [
        ...closedCandles,
        {
          timestamp: forming,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          takerBuyVolume: bar.takerBuyVolume,
        },
      ],
      symbol: 'BTCUSDT',
      interval,
      style,
      futures: null,
      sentiment: ctx.sentiment,
      weights: ctx.weights,
      htfContext: null,
    });
    const got = scoreProvisional(ctx, bar);
    expect(got).toEqual({
      openTime: forming,
      score: expected.score,
      tier: expected.tier,
      confidence: expected.confidence,
      components: expected.components,
    });
  });

  it('does not mutate the context window', () => {
    const before = ctx.closedCandles.length;
    scoreProvisional(ctx, bar);
    expect(ctx.closedCandles).toHaveLength(before);
  });
});
