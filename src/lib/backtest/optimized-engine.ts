import type { OHLCV } from '@/types/market';
import type { IndicatorConfig, IndicatorSuite } from '@/lib/indicators/types';
import { computeAllIndicators } from '@/lib/indicators/compute';
import { computeWarmupBars, interpretIndicatorsAtBar } from '@/lib/indicators/interpret-at-bar';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import { alignHtfToLtf, computeHtfSeries, htfContextAtBar } from '@/lib/signals/htf';
import { intervalToMs } from '@/lib/intervals';
import type { HtfContext } from '@/types/signal';
import { buildSnapshotSeries, type LeanSnapshot, type SnapshotBar } from './snapshot-series';
import { buildResearchSeries, type ResearchBar, type ResearchRow } from './research-series';
import { runBarLoop, type BarLoopHtf } from './bar-loop';
import type { Strategy } from './strategy';
import { createScoreThresholdStrategy } from './strategies/score-threshold';
import type {
  BacktestConfig,
  BacktestResult,
  BacktestProgressCallback,
} from './types';
import type { SuperTrendPoint } from '@/lib/indicators/supertrend';

export { computeSnapshotCoverage } from './bar-loop';

/**
 * Pre-computed indicators for optimization
 */
export interface HtfInput {
  candles: OHLCV[];
  interval: string;
}

export interface PreparedBacktest {
  candles: OHLCV[];
  indicators: IndicatorSuite[]; // Pre-computed for all bars
  superTrend: SuperTrendPoint[];
  warmupBars: number;
  stOffset: number;
  snapshots?: (SnapshotBar | null)[]; // index-aligned point-in-time futures/sentiment
  research?: (ResearchBar | null)[]; // index-aligned research-only columns
  htf?: BarLoopHtf & { interval: string };
}

/**
 * Precompute per-HTF-bar contexts and the closed-bar LTF alignment.
 * Shared by both engines so their MTF behavior cannot diverge.
 */
export function prepareHtf(
  ltfCandles: OHLCV[],
  ltfInterval: string,
  htfInput: HtfInput,
  indicatorConfig?: IndicatorConfig
): NonNullable<PreparedBacktest['htf']> {
  const series = computeHtfSeries(htfInput.candles, indicatorConfig);
  const contextAtHtfBar: (HtfContext | null)[] = htfInput.candles.map((_, bar) =>
    htfContextAtBar(series, bar, htfInput.interval)
  );
  const ltfToHtf = alignHtfToLtf(
    ltfCandles,
    intervalToMs(ltfInterval),
    htfInput.candles,
    intervalToMs(htfInput.interval)
  );

  return { interval: htfInput.interval, contextAtHtfBar, ltfToHtf };
}

/**
 * Prepare backtest: compute indicators once
 * Reuse for multiple weight candidates
 * Optional indicatorConfig allows style-specific indicator parameters
 * Optional snapshotDocs supply point-in-time futures/sentiment per bar
 * Optional researchRows supply research-only per-bar columns. They are keyed
 * by candle open time and are precomputed over the FULL series by the caller,
 * so preparing a slice selects a sub-range rather than recomputing a shorter
 * window; see research-series.ts for why that distinction matters.
 */
export function prepareBacktest(
  candles: OHLCV[],
  symbol: string,
  interval: string,
  indicatorConfig?: IndicatorConfig,
  snapshotDocs?: LeanSnapshot[],
  htfInput?: HtfInput,
  researchRows?: readonly ResearchRow[]
): PreparedBacktest {
  // Compute raw indicators with optional style-specific config
  const raw = computeAllIndicators(candles, symbol, interval, indicatorConfig);
  const superTrend = computeSuperTrend(candles);
  const warmup = computeWarmupBars(raw);

  // Pre-compute interpreted indicators for all bars
  const indicators: IndicatorSuite[] = [];
  for (let bar = 0; bar < candles.length; bar++) {
    const suite = interpretIndicatorsAtBar(raw, bar, candles);
    indicators.push(suite);
  }

  const stOffset = candles.length - superTrend.values.length;

  return {
    candles,
    indicators,
    superTrend: superTrend.values,
    warmupBars: warmup,
    stOffset,
    ...(snapshotDocs
      ? { snapshots: buildSnapshotSeries(candles, snapshotDocs, interval, { symbol }) }
      : {}),
    ...(researchRows ? { research: buildResearchSeries(candles, researchRows) } : {}),
    ...(htfInput ? { htf: prepareHtf(candles, interval, htfInput, indicatorConfig) } : {}),
  };
}

/**
 * Run backtest with pre-computed indicators
 * Only weights differ between runs
 */
export function runOptimizedBacktest(
  prepared: PreparedBacktest,
  config: BacktestConfig,
  symbol: string,
  interval: string,
  onProgress?: BacktestProgressCallback,
  strategy: Strategy = createScoreThresholdStrategy()
): BacktestResult {
  const { candles, indicators, superTrend, warmupBars, stOffset, snapshots, research, htf } = prepared;

  return runBarLoop({
    candles,
    config,
    symbol,
    interval,
    warmupBars,
    suiteAtBar: (bar) => indicators[bar],
    superTrend,
    stOffset,
    htf,
    snapshots,
    research,
    strategy,
    onProgress,
  });
}
