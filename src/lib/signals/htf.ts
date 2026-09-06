import type { OHLCV } from '@/types/market';
import type { HtfContext } from '@/types/signal';
import type { TradingStyle } from '@/lib/models/signal-template';
import type { IndicatorConfig } from '@/lib/indicators/types';
import { DEFAULT_CONFIG } from '@/lib/indicators/types';
import { computeEMA, computeSMA } from '@/lib/indicators/compute';
import { computeSuperTrend, type SuperTrendPoint } from '@/lib/indicators/supertrend';

/**
 * Higher-timeframe confluence: a compact trend-only assessment of the
 * confirmation timeframe, scored as the seventh signal category.
 *
 * All series are causal (EMA/SMA/SuperTrend at bar i depend only on bars <= i),
 * so alignment is the only place lookahead can enter; alignHtfToLtf enforces
 * closed-bar-only mapping.
 */

// Confirmation timeframe per signal interval. A style override exists so a
// style can diverge later without touching callers.
const CONFIRMATION_MAP: Record<string, string | null> = {
  '1m': '15m',
  '5m': '1h',
  '15m': '4h',
  '1h': '4h',
  '4h': '1d',
  '1d': null, // no 1w candles in the system; capped deliberately
};

const STYLE_OVERRIDES: Partial<Record<TradingStyle, Record<string, string | null>>> = {};

export function getConfirmationInterval(
  interval: string,
  style?: TradingStyle
): string | null {
  if (style) {
    const override = STYLE_OVERRIDES[style]?.[interval];
    if (override !== undefined) return override;
  }
  return CONFIRMATION_MAP[interval] ?? null;
}

export interface HtfSeries {
  candleCount: number;
  timestamps: number[]; // open time per HTF bar
  closes: number[];
  emaFast: number[];
  emaSlow: number[];
  smaMedium: number[];
  smaLong: number[];
  superTrend: SuperTrendPoint[];
  stOffset: number;
}

export function computeHtfSeries(
  htfCandles: OHLCV[],
  config: IndicatorConfig = DEFAULT_CONFIG
): HtfSeries {
  const closes = htfCandles.map((c) => c.close);
  const superTrend = computeSuperTrend(htfCandles);

  return {
    candleCount: htfCandles.length,
    timestamps: htfCandles.map((c) => c.timestamp),
    closes,
    emaFast: computeEMA(closes, config.ema.fast).values,
    emaSlow: computeEMA(closes, config.ema.slow).values,
    smaMedium: computeSMA(closes, config.sma.medium).values,
    smaLong: computeSMA(closes, config.sma.long).values,
    superTrend: superTrend.values,
    stOffset: htfCandles.length - superTrend.values.length,
  };
}

function readAt(values: number[], bar: number, candleCount: number): number | undefined {
  const idx = bar - (candleCount - values.length);
  return idx >= 0 && idx < values.length ? values[idx] : undefined;
}

/**
 * Assessment at one HTF bar; null during indicator warmup.
 */
export function htfContextAtBar(
  series: HtfSeries,
  htfBar: number,
  htfInterval: string
): HtfContext | null {
  if (htfBar < 0 || htfBar >= series.candleCount) return null;

  const emaFast = readAt(series.emaFast, htfBar, series.candleCount);
  const emaSlow = readAt(series.emaSlow, htfBar, series.candleCount);
  const smaMedium = readAt(series.smaMedium, htfBar, series.candleCount);
  const smaLong = readAt(series.smaLong, htfBar, series.candleCount);
  const stIdx = htfBar - series.stOffset;
  const st = stIdx >= 0 && stIdx < series.superTrend.length ? series.superTrend[stIdx] : undefined;

  if (
    emaFast === undefined ||
    emaSlow === undefined ||
    smaMedium === undefined ||
    smaLong === undefined ||
    st === undefined
  ) {
    return null;
  }

  const close = series.closes[htfBar];
  const signals: HtfContext['signals'] = [];

  const emaBullish = emaFast > emaSlow;
  signals.push({
    name: 'HTF EMA Cross',
    value: emaFast - emaSlow,
    direction: emaBullish ? 'bullish' : 'bearish',
    strength: 60,
    description: `${htfInterval} EMA fast ${emaBullish ? 'above' : 'below'} slow`,
  });

  const aboveBoth = close > smaMedium && close > smaLong;
  const belowBoth = close < smaMedium && close < smaLong;
  signals.push({
    name: 'HTF SMA Trend',
    value: close,
    direction: aboveBoth ? 'bullish' : belowBoth ? 'bearish' : 'neutral',
    strength: 50,
    description: aboveBoth
      ? `${htfInterval} price above both SMAs`
      : belowBoth
        ? `${htfInterval} price below both SMAs`
        : `${htfInterval} price between SMAs`,
  });

  signals.push({
    name: 'HTF SuperTrend',
    value: st.direction === 'up' ? 1 : -1,
    direction: st.direction === 'up' ? 'bullish' : 'bearish',
    strength: 70,
    description: `${htfInterval} SuperTrend ${st.direction === 'up' ? 'bullish' : 'bearish'}`,
  });

  const net = signals.reduce(
    (sum, s) => sum + (s.direction === 'bullish' ? 1 : s.direction === 'bearish' ? -1 : 0),
    0
  );

  return {
    interval: htfInterval,
    candleTimestamp: series.timestamps[htfBar],
    trendDirection: net > 0 ? 'bullish' : net < 0 ? 'bearish' : 'neutral',
    signals,
  };
}

/**
 * Map every LTF bar to the newest HTF bar whose CLOSE is at or before the
 * LTF bar's close: htf.timestamp + htfMs <= ltf.timestamp + ltfMs.
 * -1 where no HTF bar qualifies. This is the no-lookahead invariant: an HTF
 * candle still in progress at the LTF decision time is never used.
 */
export function alignHtfToLtf(
  ltfCandles: OHLCV[],
  ltfMs: number,
  htfCandles: OHLCV[],
  htfMs: number
): Int32Array {
  const map = new Int32Array(ltfCandles.length).fill(-1);
  let htfIdx = -1;

  for (let i = 0; i < ltfCandles.length; i++) {
    const ltfClose = ltfCandles[i].timestamp + ltfMs;
    while (
      htfIdx + 1 < htfCandles.length &&
      htfCandles[htfIdx + 1].timestamp + htfMs <= ltfClose
    ) {
      htfIdx++;
    }
    map[i] = htfIdx;
  }

  return map;
}
