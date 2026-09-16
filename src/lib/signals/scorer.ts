import type { IndicatorSignal, IndicatorSuite, SignalDirection } from '@/lib/indicators/types';
import type { SuperTrendResult } from '@/lib/indicators/supertrend';
import type { FuturesData } from '@/types/futures';
import type {
  CompositeSignal,
  HtfContext,
  SentimentData,
  SignalComponent,
  SignalTier,
  SignalWeights,
} from '@/types/signal';
import { DEFAULT_WEIGHTS } from '@/types/signal';
import { TIER_BUY_CUTOFF, TIER_STRONG_CUTOFF } from './calibration';

function directionToMultiplier(direction: SignalDirection): number {
  if (direction === 'bullish') return 1;
  if (direction === 'bearish') return -1;
  return 0;
}

function categoryScore(signals: IndicatorSignal[]): number {
  if (signals.length === 0) return 0;

  let totalWeight = 0;
  let weightedSum = 0;

  for (const s of signals) {
    const multiplier = directionToMultiplier(s.direction);
    const contribution = multiplier * s.strength;
    weightedSum += contribution;
    totalWeight += 1;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

function scoreTrend(
  indicators: IndicatorSuite,
  superTrend?: SuperTrendResult | null
): SignalComponent {
  const signals = [...indicators.signals.trend];

  if (superTrend) {
    const { direction } = superTrend.current;
    signals.push({
      name: 'SuperTrend',
      value: direction === 'up' ? 1 : -1,
      direction: direction === 'up' ? 'bullish' : 'bearish',
      strength: 60,
      description: `SuperTrend ${direction === 'up' ? 'bullish' : 'bearish'}`,
    });
  }

  return {
    category: 'trend',
    score: categoryScore(signals),
    weight: 0,
    weightedScore: 0,
    signals: signals.map((s) => ({
      name: s.name,
      direction: s.direction,
      strength: s.strength,
      description: s.description,
    })),
  };
}

function scoreMomentum(indicators: IndicatorSuite): SignalComponent {
  return {
    category: 'momentum',
    score: categoryScore(indicators.signals.momentum),
    weight: 0,
    weightedScore: 0,
    signals: indicators.signals.momentum.map((s) => ({
      name: s.name,
      direction: s.direction,
      strength: s.strength,
      description: s.description,
    })),
  };
}

function scoreVolume(indicators: IndicatorSuite): SignalComponent {
  return {
    category: 'volume',
    score: categoryScore(indicators.signals.volume),
    weight: 0,
    weightedScore: 0,
    signals: indicators.signals.volume.map((s) => ({
      name: s.name,
      direction: s.direction,
      strength: s.strength,
      description: s.description,
    })),
  };
}

function scoreVolatility(indicators: IndicatorSuite): SignalComponent {
  // ATR is a volatility regime reading, not a directional signal -- it always
  // reports neutral and would dilute the category score toward 0. It stays in
  // the displayed signals but is excluded from the directional mean; its
  // regime feeds computeConfidence instead.
  const directional = indicators.signals.volatility.filter((s) => s.name !== 'ATR');

  return {
    category: 'volatility',
    score: categoryScore(directional),
    weight: 0,
    weightedScore: 0,
    signals: indicators.signals.volatility.map((s) => ({
      name: s.name,
      direction: s.direction,
      strength: s.strength,
      description: s.description,
    })),
  };
}

function scoreFutures(futuresData: FuturesData | null): SignalComponent {
  if (!futuresData) {
    return {
      category: 'futures',
      score: 0,
      weight: 0,
      weightedScore: 0,
      signals: [],
    };
  }

  const signals: SignalComponent['signals'] = [];

  // Funding rate: negative = bullish contrarian (shorts paying longs)
  if (futuresData.fundingRate) {
    const rate = futuresData.fundingRate.fundingRate;
    let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let strength = 0;

    if (rate < -0.001) {
      // Very negative funding = extremely bullish contrarian
      direction = 'bullish';
      strength = Math.min(90, Math.abs(rate) * 10000);
    } else if (rate < -0.0001) {
      direction = 'bullish';
      strength = 40;
    } else if (rate > 0.001) {
      // Very positive funding = bearish contrarian
      direction = 'bearish';
      strength = Math.min(90, rate * 10000);
    } else if (rate > 0.0001) {
      direction = 'bearish';
      strength = 40;
    }

    signals.push({
      name: 'Funding Rate',
      direction,
      strength,
      description: `Funding rate: ${(rate * 100).toFixed(4)}%`,
    });
  }

  // Long/Short ratio: deviation from 1.0
  if (futuresData.longShortRatio) {
    const ratio = futuresData.longShortRatio.longShortRatio;
    let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let strength = 0;

    if (ratio > 2.0) {
      // Heavily long = bearish contrarian
      direction = 'bearish';
      strength = Math.min(80, (ratio - 1) * 40);
    } else if (ratio > 1.3) {
      direction = 'bearish';
      strength = 40;
    } else if (ratio < 0.5) {
      // Heavily short = bullish contrarian
      direction = 'bullish';
      strength = Math.min(80, (1 / ratio - 1) * 40);
    } else if (ratio < 0.77) {
      direction = 'bullish';
      strength = 40;
    }

    signals.push({
      name: 'Long/Short Ratio',
      direction,
      strength,
      description: `L/S ratio: ${ratio.toFixed(2)}`,
    });
  }

  const score = categoryScore(
    signals.map((s) => ({
      ...s,
      value: 0,
    }))
  );

  return {
    category: 'futures',
    score,
    weight: 0,
    weightedScore: 0,
    signals,
  };
}

function scoreSentiment(sentimentData: SentimentData | null): SignalComponent {
  if (!sentimentData) {
    return {
      category: 'sentiment',
      score: 0,
      weight: 0,
      weightedScore: 0,
      signals: [],
    };
  }

  const { fearGreedIndex, label } = sentimentData;
  let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  let strength = 0;

  // Extreme fear = bullish contrarian, extreme greed = bearish contrarian
  if (fearGreedIndex <= 10) {
    direction = 'bullish';
    strength = 80;
  } else if (fearGreedIndex <= 25) {
    direction = 'bullish';
    strength = 60;
  } else if (fearGreedIndex >= 90) {
    direction = 'bearish';
    strength = 80;
  } else if (fearGreedIndex >= 75) {
    direction = 'bearish';
    strength = 60;
  } else if (fearGreedIndex >= 60) {
    direction = 'bearish';
    strength = 20;
  } else if (fearGreedIndex <= 40) {
    direction = 'bullish';
    strength = 20;
  }

  const signals: SignalComponent['signals'] = [
    {
      name: 'Fear & Greed',
      direction,
      strength,
      description: `${label} (${fearGreedIndex})`,
    },
  ];

  // Keyword news sentiment is directional evidence (positive headlines are
  // bullish), unlike the contrarian Fear & Greed read. Needs a minimum sample
  // and a clear tilt to count.
  const news = sentimentData.news;
  if (news && news.count >= 3 && Math.abs(news.avgSentiment) >= 0.15) {
    const newsDirection = news.avgSentiment > 0 ? 'bullish' : 'bearish';
    signals.push({
      name: 'News',
      direction: newsDirection,
      strength: Math.min(70, Math.round(Math.abs(news.avgSentiment) * 200)),
      description: `${news.count} articles, avg sentiment ${news.avgSentiment.toFixed(2)}`,
    });
  }

  return {
    category: 'sentiment',
    score: categoryScore(
      signals.map((s) => ({ ...s, value: 0 }))
    ),
    weight: 0,
    weightedScore: 0,
    signals,
  };
}

function scoreHtf(htfContext: HtfContext | null): SignalComponent {
  if (!htfContext || htfContext.signals.length === 0) {
    return {
      category: 'htf',
      score: 0,
      weight: 0,
      weightedScore: 0,
      signals: [],
    };
  }

  return {
    category: 'htf',
    score: categoryScore(htfContext.signals),
    weight: 0,
    weightedScore: 0,
    signals: htfContext.signals.map((s) => ({
      name: s.name,
      direction: s.direction,
      strength: s.strength,
      description: s.description,
    })),
  };
}

/** Cutoffs are measured, not chosen: see calibration.ts. */
export function getTier(score: number): SignalTier {
  if (score > TIER_STRONG_CUTOFF) return 'strong_buy';
  if (score > TIER_BUY_CUTOFF) return 'buy';
  if (score < -TIER_STRONG_CUTOFF) return 'strong_sell';
  if (score < -TIER_BUY_CUTOFF) return 'sell';
  return 'neutral';
}

function computeConfidence(
  futuresData: FuturesData | null,
  sentimentData: SentimentData | null,
  weights: SignalWeights,
  indicators?: IndicatorSuite,
  htfContext?: HtfContext | null
): number {
  // Start at 100%, degrade for missing data sources
  let confidence = 100;

  if (!futuresData) {
    confidence -= weights.futures * 100;
  }
  if (!sentimentData) {
    confidence -= weights.sentiment * 100;
  }
  if (!htfContext) {
    confidence -= (weights.htf ?? 0) * 100;
  }

  // Volatility regime: extreme ATR makes any directional read less reliable
  const atrSignal = indicators?.signals.volatility.find((s) => s.name === 'ATR');
  if (atrSignal) {
    if (atrSignal.strength >= 80) {
      confidence -= 15;
    } else if (atrSignal.strength >= 50) {
      confidence -= 5;
    }
  }

  return Math.max(0, Math.round(confidence));
}

export function computeSignalScore(
  indicators: IndicatorSuite,
  futuresData: FuturesData | null = null,
  sentimentData: SentimentData | null = null,
  weights: SignalWeights = DEFAULT_WEIGHTS,
  superTrend?: SuperTrendResult | null,
  htfContext: HtfContext | null = null
): CompositeSignal {
  // Compute per-category scores.
  // components and categoryKeys are positionally coupled: append together.
  const components: SignalComponent[] = [
    scoreTrend(indicators, superTrend),
    scoreMomentum(indicators),
    scoreVolume(indicators),
    scoreVolatility(indicators),
    scoreFutures(futuresData),
    scoreSentiment(sentimentData),
    scoreHtf(htfContext),
  ];

  // Apply weights
  const categoryKeys: (keyof SignalWeights)[] = [
    'trend', 'momentum', 'volume', 'volatility', 'futures', 'sentiment', 'htf',
  ];

  // When data sources are missing, redistribute weights
  let availableWeight = 0;
  for (let i = 0; i < components.length; i++) {
    const key = categoryKeys[i];
    if (components[i].signals.length > 0) {
      availableWeight += weights[key];
    }
  }

  let totalScore = 0;
  for (let i = 0; i < components.length; i++) {
    const key = categoryKeys[i];
    if (components[i].signals.length > 0 && availableWeight > 0) {
      // Normalize weight so available components sum to 1.0
      const normalizedWeight = weights[key] / availableWeight;
      components[i].weight = normalizedWeight;
      components[i].weightedScore = components[i].score * normalizedWeight;
      totalScore += components[i].weightedScore;
    } else {
      components[i].weight = 0;
      components[i].weightedScore = 0;
    }
  }

  // Clamp to [-100, 100]
  const score = Math.max(-100, Math.min(100, totalScore));

  return {
    symbol: indicators.symbol,
    interval: indicators.interval,
    score,
    tier: getTier(score),
    confidence: computeConfidence(futuresData, sentimentData, weights, indicators, htfContext),
    components,
    timestamp: Date.now(),
  };
}
