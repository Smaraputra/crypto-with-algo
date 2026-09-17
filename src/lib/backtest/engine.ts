import type { OHLCV } from '@/types/market';
import { computeAllIndicators } from '@/lib/indicators/compute';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import { computeWarmupBars, interpretIndicatorsAtBar } from '@/lib/indicators/interpret-at-bar';
import { prepareHtf, type HtfInput } from './optimized-engine';
import { runBarLoop } from './bar-loop';
import type { Strategy } from './strategy';
import { createScoreThresholdStrategy } from './strategies/score-threshold';
import type {
  BacktestConfig,
  BacktestResult,
  BacktestProgressCallback,
} from './types';
import type { SnapshotBar } from './snapshot-series';

export { computeSnapshotCoverage } from './bar-loop';

export function runBacktest(
  candles: OHLCV[],
  config: BacktestConfig,
  symbol: string,
  interval: string,
  onProgress?: BacktestProgressCallback,
  snapshots?: (SnapshotBar | null)[],
  htfInput?: HtfInput,
  strategy: Strategy = createScoreThresholdStrategy()
): BacktestResult {
  // 1. Compute all indicators once
  const raw = computeAllIndicators(candles, symbol, interval);
  const superTrend = computeSuperTrend(candles);
  const warmup = computeWarmupBars(raw);
  const htf = htfInput ? prepareHtf(candles, interval, htfInput) : undefined;

  // 2. Run the shared per-bar state machine
  return runBarLoop({
    candles,
    config,
    symbol,
    interval,
    warmupBars: warmup,
    suiteAtBar: (bar) => interpretIndicatorsAtBar(raw, bar, candles),
    superTrend: superTrend.values,
    stOffset: candles.length - superTrend.values.length,
    htf,
    snapshots,
    strategy,
    onProgress,
  });
}
