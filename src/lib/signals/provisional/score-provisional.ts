import { scoreBar } from '@/lib/signals/score-bar';
import type { OHLCV } from '@/types/market';
import type { FormingBar, ProvisionalContextReady, ProvisionalScore } from './types';

/**
 * Display-only score for the forming bar: the scheduler's own `scoreBar` over
 * the closed window plus the forming bar as the newest element. Pure and
 * browser-safe. Returns null when the bar is not the one the context was built
 * for or carries a non-finite value. The result is never persisted; the
 * scheduler's recorded value replaces it once the bar closes.
 */
export function scoreProvisional(
  ctx: ProvisionalContextReady,
  bar: FormingBar
): ProvisionalScore | null {
  if (bar.openTime !== ctx.formingOpenTime) return null;
  const values = [bar.open, bar.high, bar.low, bar.close, bar.volume, bar.takerBuyVolume];
  if (!values.every(Number.isFinite)) return null;

  const formingCandle: OHLCV = {
    timestamp: bar.openTime,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    takerBuyVolume: bar.takerBuyVolume,
  };
  const signal = scoreBar({
    candles: [...ctx.closedCandles, formingCandle],
    symbol: ctx.symbol,
    interval: ctx.interval,
    style: ctx.style,
    futures: ctx.futures,
    sentiment: ctx.sentiment,
    weights: ctx.weights,
    htfContext: ctx.htfContext,
  });
  return {
    openTime: bar.openTime,
    score: signal.score,
    tier: signal.tier,
    confidence: signal.confidence,
    components: signal.components,
  };
}
