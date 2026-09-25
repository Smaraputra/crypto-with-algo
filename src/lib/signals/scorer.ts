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

/**
 * Mean of the directional readings, with neutral ones ABSTAINING.
 *
 * A neutral signal previously contributed 0 to the numerator while still
 * counting 1 in the denominator, so it did not abstain -- it voted for zero.
 * Most indicators sit in their indifference band most of the time (RSI between
 * 40 and 60, Williams %R between -80 and -20, %B between 0.2 and 0.8, MFI
 * between 40 and 60, Fear & Greed between 40 and 60, funding at its base rate),
 * so the score's magnitude was largely a count of how many indicators happened
 * to be undecided rather than a measure of conviction. That is the main reason
 * |score| p90 sat around 24 on a nominal +/-100 scale.
 *
 * The codebase already had this right in two places and generalising it was the
 * fix: `scoreVolatility` excludes ATR from the mean for exactly this reason,
 * and `interpretTakerFlow` returns null in its indifferent band "so it never
 * dilutes the volume category".
 *
 * A category of nothing but neutral readings now scores 0 because it has no
 * opinion, not because its opinions cancelled -- and `signals.length > 0` still
 * keeps its weight, which is correct: the data arrived, it just said nothing.
 */
function categoryScore(signals: IndicatorSignal[]): number {
  const directional = signals.filter((s) => directionToMultiplier(s.direction) !== 0);
  if (directional.length === 0) return 0;

  let weightedSum = 0;
  for (const s of directional) {
    weightedSum += directionToMultiplier(s.direction) * s.strength;
  }

  return weightedSum / directional.length;
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

    // Strength must rise with |rate|, which it previously did not: the
    // "extreme" branch computed |rate| * 10000, so at -0.0011 it returned 11
    // while the milder branch below it returned a flat 40. Strength therefore
    // DROPPED by 29 points as the signal got stronger, and only passed 40 again
    // beyond |rate| > 0.004 -- off the observed distribution for these symbols.
    //
    // Scaled so the escalation threshold is continuous: 40 at |rate| = 0.001,
    // rising to the 90 cap at 0.00225. The mild branch keeps its flat 40, so the
    // function is monotonic across the whole range.
    const EXTREME = 0.001;
    const NEUTRAL_BAND = 0.0001;
    const extremeStrength = (absRate: number) =>
      Math.min(90, 40 + (absRate - EXTREME) * 40000);

    if (rate < -EXTREME) {
      // Very negative funding = extremely bullish contrarian
      direction = 'bullish';
      strength = extremeStrength(Math.abs(rate));
    } else if (rate < -NEUTRAL_BAND) {
      direction = 'bullish';
      strength = 40;
    } else if (rate > EXTREME) {
      // Very positive funding = bearish contrarian
      direction = 'bearish';
      strength = extremeStrength(rate);
    } else if (rate > NEUTRAL_BAND) {
      direction = 'bearish';
      strength = 40;
    }
    // Note on the neutral band: it is [-0.0001, +0.0001] INCLUSIVE, and
    // Binance's base funding rate is exactly 0.0001 for most perpetuals most of
    // the time, so the single most common funding value reads neutral. That is
    // deliberate -- base funding carries no contrarian information -- and it is
    // only harmless because a neutral reading now abstains from its category
    // mean rather than dragging it to zero.

    signals.push({
      name: 'Funding Rate',
      direction,
      strength,
      description: `Funding rate: ${(rate * 100).toFixed(4)}%`,
    });
  }

  // Long/Short ratio: deviation from 1.0.
  //
  // MEASURED DEFECT, 2026-09-25, NOT YET FIXED. These bands assume the ratio is
  // centred on 1.0. It is not, and worse, its centre MOVES.
  //
  // The field holds the TOP TRADER POSITION ratio, whose pooled median over
  // 436,552 stored snapshots is 1.513 and mean 1.718. Per-symbol medians run
  // 1.18 (BNB) to 2.22 (DOGE). Against the 1.3 trigger below that makes
  // 65.1% of all bars read bearish and 0.4% bullish -- a 163:1 asymmetry. The
  // 0.77 bullish trigger sits BELOW the 5th percentile of every symbol (the
  // lowest value ever observed for any of them is 0.68), so the bullish branch
  // is close to dead code, and 26.3% of bars land above 2.0, a branch written
  // to mark an extreme.
  //
  // The centre also drifts by more than the band is wide, so no fixed threshold
  // can be correct. Share of bars called bearish, by quarter:
  //
  //           BTC    ETH   DOGE    BNB
  //   2023Q1    3%    22%    87%     0%
  //   2024Q1   76%   100%   100%    64%
  //   2025Q3  100%   100%   100%    16%
  //   2026Q2   10%    47%   100%    47%
  //   2026Q3   94%    86%   100%   100%
  //
  // ETH read bearish on 100% of bars for the eight consecutive quarters from
  // 2024Q1 to 2025Q4. A signal that never changes direction carries no
  // information; over those stretches this contributes a constant offset to
  // every composite and nothing else. Weighted through, the standing bearish
  // contribution is -2.1 points of composite for scalping, -4.2 day_trading,
  // -8.8 swing_trading and -12.3 position_trading, where futures carries 0.25
  // of the weight.
  //
  // The fix shape is already validated by the research side: a WITHIN-SYMBOL
  // trailing z, which is what Phase 3b used when the raw level failed quarter
  // agreement. Measured on the same snapshots with a 30-day trailing window,
  // |z| > 1 gives 27.0% bearish and 22.1% bullish pooled, and stays inside
  // 24.6-29.0% / 19.4-23.8% for every symbol.
  //
  // Not fixed here because it changes live scoring, which means configVersion 8
  // and another break in the live record. Note that the research record also
  // says positioning is "a robust factor, not an edge" -- both rule shapes
  // failed the gates -- so this fix buys honesty and cross-symbol
  // comparability, not profit.
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
