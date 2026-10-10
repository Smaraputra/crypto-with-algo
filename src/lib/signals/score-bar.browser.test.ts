// @vitest-environment jsdom
// Proves scoreBar loads and runs in a browser-like environment (no node-only
// or server-only imports on its module graph).
import { describe, expect, it } from 'vitest';

import { DEFAULT_TEMPLATE_WEIGHTS } from '@/lib/models/signal-template';
import { buildCandles, lastClosedOpenTime, seedFor } from '@/__fixtures__/scoring-fixture';
import { scoreBar } from './score-bar';

describe('scoreBar in jsdom', () => {
  it('scores the fixture', () => {
    expect(typeof window).toBe('object');
    const candles = buildCandles({
      symbol: 'BTCUSDT',
      interval: '1h',
      count: 300,
      endOpenTime: lastClosedOpenTime('1h'),
      seed: seedFor('score-bar', 'jsdom'),
      startPrice: 60000,
    });
    const signal = scoreBar({
      candles,
      symbol: 'BTCUSDT',
      interval: '1h',
      style: 'day_trading',
      futures: null,
      sentiment: null,
      weights: DEFAULT_TEMPLATE_WEIGHTS.day_trading,
      htfContext: null,
    });
    expect(Number.isFinite(signal.score)).toBe(true);
    expect(signal.symbol).toBe('BTCUSDT');
  });
});
