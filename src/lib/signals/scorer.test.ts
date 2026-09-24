import { describe, expect, it } from 'vitest';

import { computeAllIndicators } from '@/lib/indicators/compute';
import { interpretIndicators } from '@/lib/indicators/interpret';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import type { FuturesData } from '@/types/futures';
import type { OHLCV } from '@/types/market';
import type { HtfContext, SentimentData, SignalWeights } from '@/types/signal';
import { DEFAULT_WEIGHTS } from '@/types/signal';

import { computeSignalScore, getTier } from './scorer';
import { TIER_BUY_CUTOFF, TIER_STRONG_CUTOFF } from './calibration';

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
    if (result.score > TIER_STRONG_CUTOFF) expect(result.tier).toBe('strong_buy');
    else if (result.score > TIER_BUY_CUTOFF) expect(result.tier).toBe('buy');
  });

  it('tier matches score range - sell', () => {
    const suite = makeIndicatorSuite('down');
    const result = computeSignalScore(suite);
    if (result.score < -TIER_STRONG_CUTOFF) expect(result.tier).toBe('strong_sell');
    else if (result.score < -TIER_BUY_CUTOFF) expect(result.tier).toBe('sell');
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

describe('getTier', () => {
  // Expressed relative to the cutoffs rather than as literals, so a
  // recalibration does not need this table rewritten. The cutoffs moved from
  // 24/30 to 30/38 on 2026-09-24 when the scorer fixes shifted the score
  // distribution, and the literal form of this table failed for no reason
  // other than the numbers being spelled out twice.
  const B = TIER_BUY_CUTOFF;
  const S = TIER_STRONG_CUTOFF;

  it.each([
    [0, 'neutral'],
    [B, 'neutral'],
    [B + 0.1, 'buy'],
    [S, 'buy'],
    [S + 0.1, 'strong_buy'],
    [-B, 'neutral'],
    [-(B + 0.1), 'sell'],
    [-S, 'sell'],
    [-(S + 0.1), 'strong_sell'],
    [100, 'strong_buy'],
    [-100, 'strong_sell'],
  ] as const)('maps %s to %s', (score, tier) => {
    expect(getTier(score)).toBe(tier);
  });

  it('treats the cutoffs themselves as belonging to the lower tier', () => {
    // The comparisons are strict, so the boundary value does not promote.
    expect(getTier(B)).toBe('neutral');
    expect(getTier(S)).toBe('buy');
  });

  it('keeps strong tiers reachable within the measured score range', () => {
    // The largest |score| p98 measured on the archive dataset after the scorer
    // fixes was 42.0 (1d position_trading); a strong cutoff at or above the top
    // of that range could never fire. Was 43 against the pre-fix distribution.
    expect(TIER_STRONG_CUTOFF).toBeLessThan(42);
    expect(TIER_BUY_CUTOFF).toBeLessThan(TIER_STRONG_CUTOFF);
  });
});

describe('funding rate strength is monotonic in |rate|', () => {
  // The escalation branch computed |rate| * 10000, so at -0.0011 it returned 11
  // while the milder branch just below it returned a flat 40: strength DROPPED
  // by 29 points as the signal got stronger, and only passed 40 again beyond
  // |rate| > 0.004, which is off the observed distribution for these symbols.
  function fundingSignal(rate: number) {
    const candles = generateCandles(250);
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
    const indicators = interpretIndicators(raw);
    const futures: FuturesData = {
      fundingRate: { symbol: 'BTCUSDT', fundingRate: rate, fundingTime: Date.now(), markPrice: 40000 },
      openInterest: null,
      longShortRatio: null,
    };

    const result = computeSignalScore(indicators, futures, null, DEFAULT_WEIGHTS);
    const futuresComponent = result.components.find((c) => c.category === 'futures')!;
    return futuresComponent.signals.find((s) => s.name === 'Funding Rate')!;
  }

  it('does not weaken as negative funding becomes more extreme', () => {
    const mild = fundingSignal(-0.0009);
    const extreme = fundingSignal(-0.0011);
    const veryExtreme = fundingSignal(-0.002);

    expect(mild.direction).toBe('bullish');
    expect(extreme.direction).toBe('bullish');
    expect(extreme.strength).toBeGreaterThanOrEqual(mild.strength);
    expect(veryExtreme.strength).toBeGreaterThan(extreme.strength);
  });

  it('does not weaken as positive funding becomes more extreme', () => {
    const mild = fundingSignal(0.0009);
    const extreme = fundingSignal(0.0011);

    expect(mild.direction).toBe('bearish');
    expect(extreme.direction).toBe('bearish');
    expect(extreme.strength).toBeGreaterThanOrEqual(mild.strength);
  });

  it('is continuous at the escalation threshold and capped at 90', () => {
    expect(fundingSignal(-0.001).strength).toBe(40);
    expect(fundingSignal(-0.05).strength).toBe(90);
  });

  it('reads the base funding rate as neutral', () => {
    // Binance's base rate is exactly 0.0001 for most perpetuals most of the
    // time, and base funding carries no contrarian information.
    const base = fundingSignal(0.0001);

    expect(base.direction).toBe('neutral');
    expect(base.strength).toBe(0);
  });
});

describe('neutral readings abstain rather than dilute', () => {
  function scoreWith(signals: Array<{ direction: 'bullish' | 'bearish' | 'neutral'; strength: number }>) {
    const candles = generateCandles(250);
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
    const indicators = interpretIndicators(raw);
    // Replace the momentum category wholesale so the arithmetic is exact.
    const patched = {
      ...indicators,
      signals: {
        ...indicators.signals,
        momentum: signals.map((s, i) => ({
          name: `M${i}`,
          value: 0,
          direction: s.direction,
          strength: s.strength,
          description: '',
        })),
      },
    };

    const result = computeSignalScore(patched, null, null, DEFAULT_WEIGHTS);
    return result.components.find((c) => c.category === 'momentum')!.score;
  }

  it('does not let a neutral reading drag a category toward zero', () => {
    const twoBullish = scoreWith([
      { direction: 'bullish', strength: 60 },
      { direction: 'bullish', strength: 60 },
    ]);
    const samePlusNeutral = scoreWith([
      { direction: 'bullish', strength: 60 },
      { direction: 'bullish', strength: 60 },
      { direction: 'neutral', strength: 10 },
    ]);

    expect(twoBullish).toBeCloseTo(60, 6);
    // Previously this averaged over three readings and returned 40.
    expect(samePlusNeutral).toBeCloseTo(60, 6);
  });

  it('scores a wholly neutral category at zero', () => {
    expect(scoreWith([
      { direction: 'neutral', strength: 10 },
      { direction: 'neutral', strength: 20 },
    ])).toBe(0);
  });

  it('still averages opposing directional readings', () => {
    // Abstention must not be confused with cancellation: these two genuinely
    // disagree and their mean is the right answer.
    expect(scoreWith([
      { direction: 'bullish', strength: 50 },
      { direction: 'bearish', strength: 50 },
    ])).toBeCloseTo(0, 6);
  });
});
