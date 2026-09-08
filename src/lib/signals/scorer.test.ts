import { describe, expect, it } from 'vitest';

import { computeAllIndicators } from '@/lib/indicators/compute';
import { interpretIndicators } from '@/lib/indicators/interpret';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import type { FuturesData } from '@/types/futures';
import type { OHLCV } from '@/types/market';
import type { HtfContext, SentimentData, SignalWeights } from '@/types/signal';
import { DEFAULT_WEIGHTS } from '@/types/signal';

import { computeSignalScore } from './scorer';

function generateCandles(
  count: number,
  startPrice = 40000,
  trend: 'up' | 'down' | 'sideways' = 'sideways'
): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = startPrice;
  const baseTime = 1700000000000;

  // Seeded LCG keeps the fixture deterministic across runs
  let rng = 42;
  function nextRandom(): number {
    rng = (rng * 16807 + 0) % 2147483647;
    return rng / 2147483647;
  }

  for (let i = 0; i < count; i++) {
    let change: number;
    if (trend === 'up') change = (Math.sin(i * 0.1) * 0.01 + 0.003) * price;
    else if (trend === 'down') change = (Math.sin(i * 0.1) * 0.01 - 0.003) * price;
    else change = Math.sin(i * 0.2) * 0.005 * price;

    const open = price;
    const close = price + change;
    const high = Math.max(open, close) * (1 + nextRandom() * 0.003);
    const low = Math.min(open, close) * (1 - nextRandom() * 0.003);

    candles.push({
      timestamp: baseTime + i * 60 * 60 * 1000,
      open, high, low, close,
      volume: 100 + nextRandom() * 200,
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

function makeHtfContext(): HtfContext {
  return {
    interval: '4h',
    candleTimestamp: 1700000000000,
    trendDirection: 'bullish',
    signals: [
      { name: 'HTF EMA Cross', value: 1, direction: 'bullish', strength: 60, description: 'test' },
      { name: 'HTF SuperTrend', value: 1, direction: 'bullish', strength: 70, description: 'test' },
    ],
  };
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
    expect(result.components).toHaveLength(7);
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
      { fearGreedIndex: 50, label: 'Neutral' },
      DEFAULT_WEIGHTS,
      null,
      makeHtfContext()
    );

    expect(result.confidence).toBe(100);
  });

  it('confidence degrades without higher-timeframe context', () => {
    const suite = makeIndicatorSuite();
    const withHtf = computeSignalScore(suite, null, null, DEFAULT_WEIGHTS, null, makeHtfContext());
    const withoutHtf = computeSignalScore(suite, null, null, DEFAULT_WEIGHTS, null, null);

    expect(withHtf.confidence).toBeGreaterThan(withoutHtf.confidence);
  });

  it('includes 7 components in stable category order', () => {
    const suite = makeIndicatorSuite();
    const result = computeSignalScore(suite);

    // components and categoryKeys in the scorer are positionally coupled;
    // this pins the order so they cannot drift apart
    expect(result.components.map((c) => c.category)).toEqual([
      'trend', 'momentum', 'volume', 'volatility', 'futures', 'sentiment', 'htf',
    ]);
  });

  it('empty htf with rescaled default weights reproduces pre-htf scores', () => {
    // The six old weights scaled by 0.90 plus htf 0.10 must be score-identical
    // to the old weights when the htf component is empty, because weight
    // redistribution normalizes by the available weight sum
    const suite = makeIndicatorSuite('up');
    const preHtfWeights: SignalWeights = {
      trend: 0.25, momentum: 0.25, volume: 0.15, volatility: 0.10, futures: 0.15, sentiment: 0.10,
      htf: 0,
    };

    const oldScore = computeSignalScore(suite, null, null, preHtfWeights);
    const newScore = computeSignalScore(suite, null, null, DEFAULT_WEIGHTS);

    expect(newScore.score).toBeCloseTo(oldScore.score, 10);
    expect(newScore.tier).toBe(oldScore.tier);
  });

  it('scores the htf component when context is provided', () => {
    const suite = makeIndicatorSuite('sideways');
    const result = computeSignalScore(suite, null, null, DEFAULT_WEIGHTS, null, makeHtfContext());

    const htfComponent = result.components.find((c) => c.category === 'htf');
    expect(htfComponent).toBeDefined();
    expect(htfComponent!.score).toBeGreaterThan(0);
    expect(htfComponent!.weight).toBeGreaterThan(0);
    expect(htfComponent!.signals.map((s) => s.name)).toContain('HTF EMA Cross');
  });

  it('weighted scores sum to approximately total score', () => {
    const suite = makeIndicatorSuite();
    const result = computeSignalScore(suite);

    const sumOfWeighted = result.components.reduce((sum, c) => sum + c.weightedScore, 0);
    expect(sumOfWeighted).toBeCloseTo(result.score, 1);
  });

  it('respects custom weights', () => {
    // Fix category scores by construction so the weight split is what varies
    const suite = makeIndicatorSuite();
    suite.signals.trend = [
      { name: 'EMA Cross', value: 1, direction: 'bullish', strength: 80, description: 'test' },
    ];
    suite.signals.momentum = [
      { name: 'RSI', value: 20, direction: 'bearish', strength: 60, description: 'test' },
    ];
    suite.signals.volume = [];
    suite.signals.volatility = [];

    const trendHeavy: SignalWeights = {
      trend: 0.70, momentum: 0.10, volume: 0.05, volatility: 0.05, futures: 0.05, sentiment: 0.05,
      htf: 0,
    };
    const momentumHeavy: SignalWeights = {
      trend: 0.10, momentum: 0.70, volume: 0.05, volatility: 0.05, futures: 0.05, sentiment: 0.05,
      htf: 0,
    };

    const trendResult = computeSignalScore(suite, null, null, trendHeavy);
    const momentumResult = computeSignalScore(suite, null, null, momentumHeavy);

    // Bullish trend dominates one, bearish momentum the other
    expect(trendResult.score).toBeGreaterThan(0);
    expect(momentumResult.score).toBeLessThan(0);
  });

  it('news sentiment adds a directional signal to the sentiment category', () => {
    const suite = makeIndicatorSuite('sideways');
    const withNews = computeSignalScore(suite, null, {
      fearGreedIndex: 50,
      label: 'Neutral',
      news: { count: 6, avgSentiment: 0.4 },
    });

    const sentimentComponent = withNews.components.find((c) => c.category === 'sentiment');
    const newsSignal = sentimentComponent!.signals.find((s) => s.name === 'News');
    expect(newsSignal).toBeDefined();
    expect(newsSignal!.direction).toBe('bullish');
    expect(newsSignal!.strength).toBe(70); // capped: 0.4 * 200 = 80 -> 70
    // Neutral F&G contributes 0; the news signal lifts the category mean
    expect(sentimentComponent!.score).toBeGreaterThan(0);
  });

  it('weak or thin news is ignored', () => {
    const suite = makeIndicatorSuite('sideways');
    const thin = computeSignalScore(suite, null, {
      fearGreedIndex: 50,
      label: 'Neutral',
      news: { count: 2, avgSentiment: 0.8 }, // too few articles
    });
    const weak = computeSignalScore(suite, null, {
      fearGreedIndex: 50,
      label: 'Neutral',
      news: { count: 10, avgSentiment: 0.1 }, // no clear tilt
    });

    for (const result of [thin, weak]) {
      const sentimentComponent = result.components.find((c) => c.category === 'sentiment');
      expect(sentimentComponent!.signals.map((s) => s.name)).toEqual(['Fear & Greed']);
    }
  });

  it('bearish news reads bearish', () => {
    const suite = makeIndicatorSuite('sideways');
    const result = computeSignalScore(suite, null, {
      fearGreedIndex: 50,
      label: 'Neutral',
      news: { count: 4, avgSentiment: -0.3 },
    });

    const sentimentComponent = result.components.find((c) => c.category === 'sentiment');
    const newsSignal = sentimentComponent!.signals.find((s) => s.name === 'News');
    expect(newsSignal!.direction).toBe('bearish');
    expect(newsSignal!.strength).toBe(60);
    expect(sentimentComponent!.score).toBeLessThan(0);
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

  it('excludes neutral ATR from the volatility category score', () => {
    const suite = makeIndicatorSuite();
    suite.signals.volatility = [
      { name: 'Bollinger', value: 0.9, direction: 'bullish', strength: 60, description: 'test' },
      { name: 'ATR', value: 6, direction: 'neutral', strength: 80, description: 'test' },
    ];

    const result = computeSignalScore(suite);
    const volatility = result.components.find((c) => c.category === 'volatility');

    // Without the exclusion the neutral ATR would halve this to 30
    expect(volatility!.score).toBeCloseTo(60);
    // ATR stays visible in the component signals
    expect(volatility!.signals.map((s) => s.name)).toContain('ATR');
  });

  it('extreme volatility regime reduces confidence', () => {
    const fullData = {
      futures: {
        fundingRate: { symbol: 'BTCUSDT', fundingRate: 0.0001, fundingTime: 0, markPrice: 40000 },
        openInterest: null,
        longShortRatio: null,
      } as FuturesData,
      sentiment: { fearGreedIndex: 50, label: 'Neutral' } as SentimentData,
    };

    const calm = makeIndicatorSuite();
    calm.signals.volatility = [
      { name: 'ATR', value: 1, direction: 'neutral', strength: 30, description: 'low vol' },
    ];
    const extreme = makeIndicatorSuite();
    extreme.signals.volatility = [
      { name: 'ATR', value: 6, direction: 'neutral', strength: 80, description: 'high vol' },
    ];
    const moderate = makeIndicatorSuite();
    moderate.signals.volatility = [
      { name: 'ATR', value: 4, direction: 'neutral', strength: 50, description: 'moderate vol' },
    ];

    const htf = makeHtfContext();
    const calmResult = computeSignalScore(calm, fullData.futures, fullData.sentiment, DEFAULT_WEIGHTS, null, htf);
    const moderateResult = computeSignalScore(moderate, fullData.futures, fullData.sentiment, DEFAULT_WEIGHTS, null, htf);
    const extremeResult = computeSignalScore(extreme, fullData.futures, fullData.sentiment, DEFAULT_WEIGHTS, null, htf);

    expect(calmResult.confidence).toBe(100);
    expect(moderateResult.confidence).toBe(95);
    expect(extremeResult.confidence).toBe(85);
  });
});
