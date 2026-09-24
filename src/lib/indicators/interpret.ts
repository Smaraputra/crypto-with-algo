import type {
  IndicatorSignal,
  IndicatorSuite,
  SignalDirection,
} from './types';
import type { computeAllIndicators } from './compute';

export type RawIndicators = ReturnType<typeof computeAllIndicators>;

function signal(
  name: string,
  value: number,
  direction: SignalDirection,
  strength: number,
  description: string
): IndicatorSignal {
  return {
    name,
    value,
    direction,
    strength: Math.max(0, Math.min(100, strength)),
    description,
  };
}

// Trend signals

export function interpretEMACross(ema12: number, ema26: number, close: number): IndicatorSignal {
  const spread = ((ema12 - ema26) / ema26) * 100;
  const aboveEma = close > ema12;

  if (ema12 > ema26) {
    const strength = Math.min(100, Math.abs(spread) * 20);
    return signal(
      'EMA Cross',
      spread,
      'bullish',
      aboveEma ? strength : strength * 0.6,
      `EMA12 above EMA26 by ${spread.toFixed(2)}%`
    );
  }

  const strength = Math.min(100, Math.abs(spread) * 20);
  return signal(
    'EMA Cross',
    spread,
    'bearish',
    aboveEma ? strength * 0.6 : strength,
    `EMA12 below EMA26 by ${Math.abs(spread).toFixed(2)}%`
  );
}

export function interpretSMATrend(
  close: number,
  sma50: number,
  sma200: number
): IndicatorSignal {
  const aboveSma50 = close > sma50;
  const aboveSma200 = close > sma200;
  const goldenCross = sma50 > sma200;

  if (aboveSma50 && aboveSma200 && goldenCross) {
    return signal('SMA Trend', close, 'bullish', 80, 'Price above SMA50 & SMA200, golden cross');
  }
  if (!aboveSma50 && !aboveSma200 && !goldenCross) {
    return signal('SMA Trend', close, 'bearish', 80, 'Price below SMA50 & SMA200, death cross');
  }
  if (aboveSma50 && goldenCross) {
    return signal('SMA Trend', close, 'bullish', 50, 'Price above SMA50, golden cross active');
  }
  if (!aboveSma50 && !goldenCross) {
    return signal('SMA Trend', close, 'bearish', 50, 'Price below SMA50, death cross active');
  }

  return signal('SMA Trend', close, 'neutral', 30, 'Mixed SMA signals');
}

export function interpretIchimoku(
  ichimoku: RawIndicators['ichimoku'],
  close: number
): IndicatorSignal | null {
  if (!ichimoku) return null;

  const { conversion, base, spanA, spanB } = ichimoku.current;
  const cloudTop = Math.max(spanA, spanB);
  const cloudBottom = Math.min(spanA, spanB);

  if (close > cloudTop && conversion > base) {
    return signal('Ichimoku', close, 'bullish', 75, 'Price above cloud, bullish TK cross');
  }
  if (close < cloudBottom && conversion < base) {
    return signal('Ichimoku', close, 'bearish', 75, 'Price below cloud, bearish TK cross');
  }
  if (close > cloudTop) {
    return signal('Ichimoku', close, 'bullish', 50, 'Price above cloud');
  }
  if (close < cloudBottom) {
    return signal('Ichimoku', close, 'bearish', 50, 'Price below cloud');
  }

  return signal('Ichimoku', close, 'neutral', 25, 'Price inside cloud');
}

// Momentum signals

export function interpretRSI(rsi: number): IndicatorSignal {
  if (rsi >= 80) {
    return signal('RSI', rsi, 'bearish', 90, `RSI extremely overbought at ${rsi.toFixed(1)}`);
  }
  if (rsi >= 70) {
    return signal('RSI', rsi, 'bearish', 65, `RSI overbought at ${rsi.toFixed(1)}`);
  }
  if (rsi <= 20) {
    return signal('RSI', rsi, 'bullish', 90, `RSI extremely oversold at ${rsi.toFixed(1)}`);
  }
  if (rsi <= 30) {
    return signal('RSI', rsi, 'bullish', 65, `RSI oversold at ${rsi.toFixed(1)}`);
  }
  if (rsi >= 60) {
    return signal('RSI', rsi, 'bullish', 30, `RSI bullish momentum at ${rsi.toFixed(1)}`);
  }
  if (rsi <= 40) {
    return signal('RSI', rsi, 'bearish', 30, `RSI bearish momentum at ${rsi.toFixed(1)}`);
  }

  return signal('RSI', rsi, 'neutral', 10, `RSI neutral at ${rsi.toFixed(1)}`);
}

export function interpretMACD(macd: RawIndicators['macd']['current']): IndicatorSignal {
  const { histogram, MACD: macdLine } = macd;

  if (macdLine > 0 && histogram > 0) {
    const strength = Math.min(100, Math.abs(histogram) * 1000);
    return signal('MACD', histogram, 'bullish', strength, 'MACD bullish with rising histogram');
  }
  if (macdLine > 0 && histogram < 0) {
    return signal('MACD', histogram, 'bullish', 30, 'MACD bullish but histogram declining');
  }
  if (macdLine < 0 && histogram < 0) {
    const strength = Math.min(100, Math.abs(histogram) * 1000);
    return signal('MACD', histogram, 'bearish', strength, 'MACD bearish with falling histogram');
  }
  if (macdLine < 0 && histogram > 0) {
    return signal('MACD', histogram, 'bearish', 30, 'MACD bearish but histogram rising');
  }

  return signal('MACD', histogram, 'neutral', 10, 'MACD at zero line');
}

export function interpretStochasticRSI(stochRSI: RawIndicators['stochasticRSI']['current']): IndicatorSignal {
  const { k, d } = stochRSI;

  if (k > 80 && d > 80) {
    return signal('StochRSI', k, 'bearish', 70, `StochRSI overbought (K: ${k.toFixed(1)}, D: ${d.toFixed(1)})`);
  }
  if (k < 20 && d < 20) {
    return signal('StochRSI', k, 'bullish', 70, `StochRSI oversold (K: ${k.toFixed(1)}, D: ${d.toFixed(1)})`);
  }
  if (k > d && k < 80) {
    return signal('StochRSI', k, 'bullish', 40, `StochRSI bullish crossover (K: ${k.toFixed(1)})`);
  }
  if (k < d && k > 20) {
    return signal('StochRSI', k, 'bearish', 40, `StochRSI bearish crossover (K: ${k.toFixed(1)})`);
  }

  return signal('StochRSI', k, 'neutral', 20, `StochRSI neutral (K: ${k.toFixed(1)})`);
}

export function interpretWilliamsR(wr: number): IndicatorSignal {
  // Williams %R ranges from -100 to 0
  if (wr > -20) {
    return signal('Williams %R', wr, 'bearish', 65, `Williams %R overbought at ${wr.toFixed(1)}`);
  }
  if (wr < -80) {
    return signal('Williams %R', wr, 'bullish', 65, `Williams %R oversold at ${wr.toFixed(1)}`);
  }

  return signal('Williams %R', wr, 'neutral', 20, `Williams %R neutral at ${wr.toFixed(1)}`);
}

// Volatility signals

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function interpretBollingerBands(bb: RawIndicators['bollingerBands']['current'], _close: number): IndicatorSignal {
  const { pb, upper, lower } = bb;
  const bandwidth = ((upper - lower) / bb.middle) * 100;

  if (pb > 1.0) {
    return signal('Bollinger', pb, 'bearish', 70, `Price above upper band (%B: ${pb.toFixed(2)})`);
  }
  if (pb < 0.0) {
    return signal('Bollinger', pb, 'bullish', 70, `Price below lower band (%B: ${pb.toFixed(2)})`);
  }
  if (pb > 0.8) {
    return signal('Bollinger', pb, 'bearish', 40, `Price near upper band (%B: ${pb.toFixed(2)})`);
  }
  if (pb < 0.2) {
    return signal('Bollinger', pb, 'bullish', 40, `Price near lower band (%B: ${pb.toFixed(2)})`);
  }

  return signal(
    'Bollinger',
    pb,
    'neutral',
    10,
    `Price within bands (%B: ${pb.toFixed(2)}, BW: ${bandwidth.toFixed(1)}%)`
  );
}

export function interpretATR(
  atr: RawIndicators['atr'],
  close: number
): IndicatorSignal {
  const atrPercent = (atr.current / close) * 100;
  // ATR doesn't give direction, just volatility magnitude
  // High ATR = trending market (strong existing trend), Low ATR = ranging (potential breakout)
  if (atrPercent > 5) {
    return signal('ATR', atrPercent, 'neutral', 80, `High volatility (ATR: ${atrPercent.toFixed(2)}% of price)`);
  }
  if (atrPercent > 3) {
    return signal('ATR', atrPercent, 'neutral', 50, `Moderate volatility (ATR: ${atrPercent.toFixed(2)}% of price)`);
  }

  return signal('ATR', atrPercent, 'neutral', 30, `Low volatility (ATR: ${atrPercent.toFixed(2)}% of price)`);
}

// Volume signals

/**
 * OBV relative to its own 20-period average.
 *
 * The DIRECTION (above or below the average) is meaningful. The magnitude used
 * to be normalised by `|sma20|`, which is not a scale: OBV is a cumulative sum
 * whose zero point is bar 0 of whatever array was passed, and
 * `computeAllIndicators` is called on the last `recommendedCandles` bars, so the
 * origin moved on every run. Where OBV's level happened to be large the
 * strength was ~0.1; where the cumulative sum happened to straddle zero it
 * pinned at 100. The number carried a rolling-window artifact, not information,
 * and OBV is a quarter of the volume category (0.255 weight for scalping).
 *
 * The natural scale for an OBV deviation is OBV's own typical per-bar movement,
 * which is the average bar volume: OBV moves by +/- one bar's volume each bar.
 * Measuring the gap in "bars' worth of volume" is origin-independent, so it
 * means the same thing whatever window was fetched.
 *
 * Full strength at ten bars' worth, because that is close to the arithmetic
 * ceiling: a 20-period SMA lags a linear trend by about 9.5 bars, so an OBV
 * that moved the same direction on every bar gaps from its own average by
 * roughly 9.5 bars of volume. Anything mixed reads proportionally less, which
 * is the point -- a five-bar threshold clamped realistic trends at 100 and
 * threw away the resolution.
 */
const OBV_FULL_STRENGTH_BARS = 10;

/**
 * `endIndex` is the position in `obv.values` being interpreted, defaulting to
 * the last. The per-bar path MUST pass it: the scale below is read from the 20
 * values ending there, and reading past the evaluated bar would be lookahead
 * (`no-lookahead.test.ts` enforces this).
 *
 * It is an index rather than a pre-sliced array on purpose. Slicing here costs
 * an allocation proportional to the bar index on every call, which is O(n^2)
 * across a research run and exhausted a 4 GB heap on the 808k-bar 5m series.
 */
export function interpretOBV(obv: RawIndicators['obv'], endIndex?: number): IndicatorSignal {
  const { current, sma20, values } = obv;
  const end = endIndex ?? values.length - 1;

  // Mean absolute bar-to-bar change over the same 20 bars the average spans,
  // i.e. average volume.
  let deltaSum = 0;
  let deltaCount = 0;
  for (let i = Math.max(1, end - 19); i <= end && i < values.length; i++) {
    deltaSum += Math.abs(values[i] - values[i - 1]);
    deltaCount++;
  }
  const avgAbsDelta = deltaCount > 0 ? deltaSum / deltaCount : 0;

  const gap = Math.abs(current - sma20);
  const strength =
    avgAbsDelta > 0
      ? Math.min(100, (gap / (avgAbsDelta * OBV_FULL_STRENGTH_BARS)) * 100)
      : 0;

  const direction = current > sma20 ? 'bullish' : 'bearish';
  const bars = avgAbsDelta > 0 ? gap / avgAbsDelta : 0;

  return signal(
    'OBV',
    current,
    direction,
    strength,
    `OBV ${direction === 'bullish' ? 'above' : 'below'} 20-period average by ${bars.toFixed(1)} bars of volume`
  );
}

export function interpretMFI(mfi: number): IndicatorSignal {
  if (mfi >= 80) {
    return signal('MFI', mfi, 'bearish', 70, `MFI overbought at ${mfi.toFixed(1)}`);
  }
  if (mfi <= 20) {
    return signal('MFI', mfi, 'bullish', 70, `MFI oversold at ${mfi.toFixed(1)}`);
  }
  if (mfi >= 60) {
    return signal('MFI', mfi, 'bullish', 30, `MFI shows buying pressure at ${mfi.toFixed(1)}`);
  }
  if (mfi <= 40) {
    return signal('MFI', mfi, 'bearish', 30, `MFI shows selling pressure at ${mfi.toFixed(1)}`);
  }

  return signal('MFI', mfi, 'neutral', 10, `MFI neutral at ${mfi.toFixed(1)}`);
}

export function interpretVolume(va: RawIndicators['volumeAnalysis']): IndicatorSignal {
  const { ratio, priceChangePercent } = va;

  // High volume confirms the bar's direction; without a clear price move it
  // stays neutral. Low volume is a low-conviction tape.
  if (ratio > 1.5 && priceChangePercent > 0.1) {
    const strength = Math.min(90, 40 + (ratio - 1.5) * 40);
    return signal(
      'Volume',
      ratio,
      'bullish',
      strength,
      `Volume ${ratio.toFixed(1)}x above average confirming up move`
    );
  }
  if (ratio > 1.5 && priceChangePercent < -0.1) {
    const strength = Math.min(90, 40 + (ratio - 1.5) * 40);
    return signal(
      'Volume',
      ratio,
      'bearish',
      strength,
      `Volume ${ratio.toFixed(1)}x above average confirming down move`
    );
  }
  if (ratio < 0.5) {
    return signal('Volume', ratio, 'neutral', 20, `Volume ${ratio.toFixed(1)}x below average (low conviction)`);
  }

  return signal('Volume', ratio, 'neutral', 10, `Volume at ${ratio.toFixed(1)}x average`);
}

/**
 * Taker flow: the aggressive-buy share of the bar's volume. Above 0.55 the
 * tape is being lifted (bullish), below 0.45 hit (bearish). Returns null in
 * the indifferent band and when the data is absent (legacy candles), so it
 * never dilutes the volume category.
 */
export function interpretTakerFlow(va: RawIndicators['volumeAnalysis']): IndicatorSignal | null {
  const { takerBuyRatio } = va;
  if (takerBuyRatio === undefined) return null;

  if (takerBuyRatio >= 0.55) {
    const strength = Math.min(85, Math.round((takerBuyRatio - 0.5) * 800));
    return signal(
      'Taker Flow',
      takerBuyRatio,
      'bullish',
      strength,
      `Aggressive buying: ${(takerBuyRatio * 100).toFixed(0)}% taker buy volume`
    );
  }
  if (takerBuyRatio <= 0.45) {
    const strength = Math.min(85, Math.round((0.5 - takerBuyRatio) * 800));
    return signal(
      'Taker Flow',
      takerBuyRatio,
      'bearish',
      strength,
      `Aggressive selling: ${(takerBuyRatio * 100).toFixed(0)}% taker buy volume`
    );
  }

  return null;
}

// Main interpretation function

export function interpretIndicators(raw: RawIndicators): IndicatorSuite {
  // The bar's real close, carried on the raw set. This was previously
  // `raw.ema12.values[length - 1]`, i.e. `raw.ema12.current` under another
  // name, so `interpretEMACross`'s `close > ema12` compared a number to itself
  // and was permanently false -- every bullish EMA reading was scored at 60%
  // of an identical bearish one. `interpretIndicatorsAtBar` always used the
  // real close, so the live scorer and the research path (and therefore the
  // percentile tables in calibration.ts) disagreed about the same bar.
  const close = raw.lastClose ?? 0;

  // Trend signals
  const trendSignals: IndicatorSignal[] = [
    interpretEMACross(raw.ema12.current, raw.ema26.current, close),
    interpretSMATrend(close, raw.sma50.current, raw.sma200.current),
  ];
  const ichimokuSignal = interpretIchimoku(raw.ichimoku, close);
  if (ichimokuSignal) trendSignals.push(ichimokuSignal);

  // Momentum signals
  const momentumSignals: IndicatorSignal[] = [
    interpretRSI(raw.rsi.current),
    interpretMACD(raw.macd.current),
    interpretStochasticRSI(raw.stochasticRSI.current),
    interpretWilliamsR(raw.williamsR.current),
  ];

  // Volatility signals
  const volatilitySignals: IndicatorSignal[] = [
    interpretBollingerBands(raw.bollingerBands.current, close),
    interpretATR(raw.atr, close),
  ];

  // Volume signals
  const volumeSignals: IndicatorSignal[] = [
    interpretOBV(raw.obv),
    interpretMFI(raw.mfi.current),
    interpretVolume(raw.volumeAnalysis),
  ];
  const takerFlowSignal = interpretTakerFlow(raw.volumeAnalysis);
  if (takerFlowSignal) volumeSignals.push(takerFlowSignal);

  return {
    ...raw,
    signals: {
      trend: trendSignals,
      momentum: momentumSignals,
      volatility: volatilitySignals,
      volume: volumeSignals,
    },
  };
}
