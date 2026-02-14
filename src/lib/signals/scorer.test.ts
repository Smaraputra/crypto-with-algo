import { describe, expect, it } from 'vitest';

import { computeAllIndicators } from '@/lib/indicators/compute';
import { interpretIndicators } from '@/lib/indicators/interpret';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import type { FuturesData } from '@/types/futures';
import type { OHLCV } from '@/types/market';
import type { SentimentData, SignalWeights } from '@/types/signal';
import { DEFAULT_WEIGHTS } from '@/types/signal';

import { computeSignalScore } from './scorer';

function generateCandles(
  count: number,
  startPrice = 40000,
  trend: 'up' | 'down' | 'sideways' = 'sideways'
): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = startPrice;
  const baseTime = Date.now() - count * 60 * 60 * 1000;

  for (let i = 0; i < count; i++) {
    let change: number;
    if (trend === 'up') change = (Math.sin(i * 0.1) * 0.01 + 0.003) * price;
    else if (trend === 'down') change = (Math.sin(i * 0.1) * 0.01 - 0.003) * price;
    else change = Math.sin(i * 0.2) * 0.005 * price;

    const open = price;
    const close = price + change;
    const high = Math.max(open, close) * (1 + Math.random() * 0.003);
    const low = Math.min(open, close) * (1 - Math.random() * 0.003);

    candles.push({
      timestamp: baseTime + i * 60 * 60 * 1000,
      open, high, low, close,
      volume: 100 + Math.random() * 200,
    });
    price = close;
  }

  return candles;
}

function makeIndicatorSuite(trend: 'up' | 'down' | 'sideways' = 'sideways') {
  const candles = generateCandles(300, 40000, trend);
  const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
  return interpretIndicators(raw);
}

describe('computeSignalScore', () => {
  it('returns a valid composite signal', () => {
    const suite = makeIndicatorSuite();
    const result = computeSignalScore(suite);

    expect(result.symbol).toBe('BTCUSDT');
    expect(result.interval).toBe('1h');
    expect(result.score).toBeGreaterThanOrEqual(-100);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(['strong_buy', 'buy', 'neutral', 'sell', 'strong_sell']).toContain(result.tier);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
    expect(result.components).toHaveLength(6);
  });

  it('score is positive for uptrend', () => {
    const suite = makeIndicatorSuite('up');
    const result = computeSignalScore(suite);
    expect(result.score).toBeGreaterThan(0);
  });

  it('score is negative for downtrend', () => {
    const suite = makeIndicatorSuite('down');
    const result = computeSignalScore(suite);
    expect(result.score).toBeLessThan(0);
  });

  it('tier matches score range - strong buy', () => {
    const suite = makeIndicatorSuite('up');
    const result = computeSignalScore(suite);
    if (result.score > 60) expect(result.tier).toBe('strong_buy');
    else if (result.score > 30) expect(result.tier).toBe('buy');
  });

  it('tier matches score range - sell', () => {
    const suite = makeIndicatorSuite('down');
    const result = computeSignalScore(suite);
    if (result.score < -60) expect(result.tier).toBe('strong_sell');
    else if (result.score < -30) expect(result.tier).toBe('sell');
  });

  it('confidence degrades without futures data', () => {
    const suite = makeIndicatorSuite();
    const withFutures = computeSignalScore(suite, {
      fundingRate: { symbol: 'BTCUSDT', fundingRate: 0.0001, fundingTime: 0, markPrice: 40000 },
      openInterest: null,
      longShortRatio: null,
    });
    const withoutFutures = computeSignalScore(suite, null);

    expect(withFutures.confidence).toBeGreaterThan(withoutFutures.confidence);
  });

  it('confidence degrades without sentiment data', () => {
    const suite = makeIndicatorSuite();
    const withSentiment = computeSignalScore(suite, null, { fearGreedIndex: 50, label: 'Neutral' });
    const withoutSentiment = computeSignalScore(suite, null, null);

    expect(withSentiment.confidence).toBeGreaterThan(withoutSentiment.confidence);
  });

  it('full confidence when all data present', () => {
    const suite = makeIndicatorSuite();
    const result = computeSignalScore(
      suite,
      {
        fundingRate: { symbol: 'BTCUSDT', fundingRate: 0.0001, fundingTime: 0, markPrice: 40000 },
        openInterest: null,
        longShortRatio: { symbol: 'BTCUSDT', longShortRatio: 1.0, longAccount: 0.5, shortAccount: 0.5, timestamp: 0 },
      },
      { fearGreedIndex: 50, label: 'Neutral' }
    );

    expect(result.confidence).toBe(100);
  });

  it('includes 6 components', () => {
    const suite = makeIndicatorSuite();
    const result = computeSignalScore(suite);

    const categories = result.components.map((c) => c.category);
    expect(categories).toContain('trend');
    expect(categories).toContain('momentum');
    expect(categories).toContain('volume');
    expect(categories).toContain('volatility');
    expect(categories).toContain('futures');
    expect(categories).toContain('sentiment');
  });

  it('weighted scores sum to approximately total score', () => {
    const suite = makeIndicatorSuite();
    const result = computeSignalScore(suite);

    const sumOfWeighted = result.components.reduce((sum, c) => sum + c.weightedScore, 0);
    expect(sumOfWeighted).toBeCloseTo(result.score, 1);
  });

  it('respects custom weights', () => {
    const suite = makeIndicatorSuite('up');
    const defaultResult = computeSignalScore(suite, null, null, DEFAULT_WEIGHTS);

    const momentumHeavy: SignalWeights = {
      trend: 0.05,
      momentum: 0.70,
      volume: 0.05,
      volatility: 0.05,
      futures: 0.10,
      sentiment: 0.05,
    };
    const momentumResult = computeSignalScore(suite, null, null, momentumHeavy);

    // Different weights should produce different scores
    expect(momentumResult.score).not.toBeCloseTo(defaultResult.score, 0);
  });

  it('extreme fear is bullish contrarian', () => {
    const suite = makeIndicatorSuite('sideways');
    const fearData: SentimentData = { fearGreedIndex: 5, label: 'Extreme Fear' };
    const result = computeSignalScore(suite, null, fearData);

    const sentimentComponent = result.components.find((c) => c.category === 'sentiment');
    expect(sentimentComponent).toBeDefined();
    expect(sentimentComponent!.score).toBeGreaterThan(0);
  });

  it('extreme greed is bearish contrarian', () => {
    const suite = makeIndicatorSuite('sideways');
    const greedData: SentimentData = { fearGreedIndex: 95, label: 'Extreme Greed' };
    const result = computeSignalScore(suite, null, greedData);

    const sentimentComponent = result.components.find((c) => c.category === 'sentiment');
    expect(sentimentComponent).toBeDefined();
    expect(sentimentComponent!.score).toBeLessThan(0);
  });

  it('negative funding rate is bullish', () => {
    const suite = makeIndicatorSuite('sideways');
    const futuresData: FuturesData = {
      fundingRate: { symbol: 'BTCUSDT', fundingRate: -0.005, fundingTime: 0, markPrice: 40000 },
      openInterest: null,
      longShortRatio: null,
    };
    const result = computeSignalScore(suite, futuresData);

    const futuresComponent = result.components.find((c) => c.category === 'futures');
    expect(futuresComponent!.score).toBeGreaterThan(0);
  });

  it('very positive funding rate is bearish', () => {
    const suite = makeIndicatorSuite('sideways');
    const futuresData: FuturesData = {
      fundingRate: { symbol: 'BTCUSDT', fundingRate: 0.005, fundingTime: 0, markPrice: 40000 },
      openInterest: null,
      longShortRatio: null,
    };
    const result = computeSignalScore(suite, futuresData);

    const futuresComponent = result.components.find((c) => c.category === 'futures');
    expect(futuresComponent!.score).toBeLessThan(0);
  });

  it('heavily long L/S ratio is bearish contrarian', () => {
    const suite = makeIndicatorSuite('sideways');
    const futuresData: FuturesData = {
      fundingRate: null,
      openInterest: null,
      longShortRatio: { symbol: 'BTCUSDT', longShortRatio: 3.0, longAccount: 0.75, shortAccount: 0.25, timestamp: 0 },
    };
    const result = computeSignalScore(suite, futuresData);

    const futuresComponent = result.components.find((c) => c.category === 'futures');
    expect(futuresComponent!.score).toBeLessThan(0);
  });

  it('heavily short L/S ratio is bullish contrarian', () => {
    const suite = makeIndicatorSuite('sideways');
    const futuresData: FuturesData = {
      fundingRate: null,
      openInterest: null,
      longShortRatio: { symbol: 'BTCUSDT', longShortRatio: 0.3, longAccount: 0.23, shortAccount: 0.77, timestamp: 0 },
    };
    const result = computeSignalScore(suite, futuresData);

    const futuresComponent = result.components.find((c) => c.category === 'futures');
    expect(futuresComponent!.score).toBeGreaterThan(0);
  });

  it('includes SuperTrend in trend component when provided', () => {
    const candles = generateCandles(300, 40000, 'up');
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
    const suite = interpretIndicators(raw);
    const st = computeSuperTrend(candles);

    const result = computeSignalScore(suite, null, null, DEFAULT_WEIGHTS, st);

    const trendComponent = result.components.find((c) => c.category === 'trend');
    const stSignal = trendComponent!.signals.find((s) => s.name === 'SuperTrend');
    expect(stSignal).toBeDefined();
    expect(stSignal!.name).toBe('SuperTrend');
    expect(['bullish', 'bearish', 'neutral']).toContain(stSignal!.direction);
    expect(typeof stSignal!.strength).toBe('number');
  });

  it('score is clamped to [-100, 100]', () => {
    const suite = makeIndicatorSuite('up');
    const result = computeSignalScore(suite);

    expect(result.score).toBeGreaterThanOrEqual(-100);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('component weights sum to approximately 1', () => {
    const suite = makeIndicatorSuite();
    const result = computeSignalScore(suite);

    const activeWeights = result.components
      .filter((c) => c.signals.length > 0)
      .reduce((sum, c) => sum + c.weight, 0);

    if (activeWeights > 0) {
      expect(activeWeights).toBeCloseTo(1, 2);
    }
  });

  it('handles missing futures and sentiment gracefully', () => {
    const suite = makeIndicatorSuite();
    const result = computeSignalScore(suite, null, null);

    // Should still produce a valid signal from TA only
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(-100);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(['strong_buy', 'buy', 'neutral', 'sell', 'strong_sell']).toContain(result.tier);
  });
});
