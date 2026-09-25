import type { IndicatorSnapshot } from '@/types/indicator-snapshot';
import type { SentimentData } from '@/types/signal';

import type { RawIndicators } from './interpret';

/**
 * The numeric indicator reading a journal entry records at capture time.
 *
 * This used to be reconstructed in the browser by regexing the first number
 * out of each signal's human-readable description (`useIndicatorSnapshot`),
 * because `ISignalComponent` persists `name`, `direction`, `strength` and
 * `description` and drops the numeric `value` the interpreter computed. That
 * path was wrong in three separate ways, all of them silent:
 *
 * - Eight of the twenty fields were never populated at all: the Bollinger
 *   bands, both EMAs, both SMAs, the MACD signal and histogram, and StochRSI D
 *   have no description carrying their value, so the detail view's labelled
 *   grid simply had nothing to show for them.
 * - `"OBV above 20-period average by 4.2 bars of volume"` yields 20, the
 *   period of the comparison average, so every entry recorded an OBV of 20.
 *   `"MACD bullish, histogram 2.3x its recent average"` stored a dimensionless
 *   multiple under `macdLine`. `"High volatility (ATR: 1.25% of price)"` stored
 *   a percentage under a field labelled ATR.
 * - The reading came from whichever `Signal` document the legacy per-user cron
 *   had written last, at whatever interval that user's strategy covered, while
 *   the journal form believed it was asking for a specific one.
 *
 * Reading the indicators directly removes all three at once, and leaves the
 * legacy scorer with no consumer.
 */
export function buildIndicatorSnapshot(
  raw: RawIndicators,
  superTrendDirection: 'up' | 'down' | null,
  sentiment: SentimentData | null
): IndicatorSnapshot {
  return {
    rsi: raw.rsi.current,
    macdLine: raw.macd.current.MACD,
    macdSignal: raw.macd.current.signal,
    macdHistogram: raw.macd.current.histogram,
    bollingerUpper: raw.bollingerBands.current.upper,
    bollingerMiddle: raw.bollingerBands.current.middle,
    bollingerLower: raw.bollingerBands.current.lower,
    ema12: raw.ema12.current,
    ema26: raw.ema26.current,
    sma50: raw.sma50.current,
    sma200: raw.sma200.current,
    // Price units, matching the "ATR" label and every other level in the grid.
    // The interpreter's percent-of-price form is a strength input, not a
    // reading to store.
    atr: raw.atr.current,
    stochRsiK: raw.stochasticRSI.current.k,
    stochRsiD: raw.stochasticRSI.current.d,
    williamsR: raw.williamsR.current,
    obv: raw.obv.current,
    mfi: raw.mfi.current,
    superTrendDirection,
    fearGreedIndex: sentiment?.fearGreedIndex ?? null,
    fearGreedLabel: sentiment?.label ?? null,
  };
}
