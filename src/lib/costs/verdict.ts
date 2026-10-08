import { normalCdf } from '@/lib/stats/normal';
import type { Breakeven } from './breakeven';

/**
 * How much of a trade's typical move its costs consume, stated as the
 * directional accuracy it needs just to break even.
 *
 * Provenance of the two cut-offs (2026-10-07). The research program measured
 * the information coefficient (rank correlation with the forward return) of
 * every input it tried; the best intraday effects were |IC| 0.02 to 0.05
 * (scripts/research/factor-ic.ts header). An IC converts to a directional hit
 * rate in two ways:
 *
 * - over every bar, for a bivariate normal, P(signs agree) = 0.5 + arcsin(IC)/pi:
 *   50.6% at IC 0.02 and 51.6% at IC 0.05;
 * - on tail trades taken only at |z| about 2, the hit rate is about
 *   Phi(2 x IC): 51.6% at IC 0.02 and 54.0% at IC 0.05.
 *
 * So above 52% a trade needs more accuracy than any every-bar signal the
 * program found, and above 55% more than even its selective tail trades
 * delivered. Below 52% costs are small next to the move. The cut-offs are
 * equivalent to cost / mean move of 0.04 and 0.10 in the symmetric case.
 *
 * Checked before freezing (2026-10-07), on the last 1,000 bars before the
 * lockbox of the ten-symbol research export (data/research, spot closes),
 * standard taker fees both legs plus the study slippage of the measurement
 * interval, symmetric breakeven at the winsorised mean move. Median symbol
 * and range:
 *
 *   hold  measured on  needed            verdict
 *   15m   5m x 3       97.8% (84.8-100)  dominate; BTC, ETH, BNB, XRP exceed
 *   1h    15m x 4      68.0% (62.5-75.5) dominate
 *   4h    1h x 4       59.0% (56.9-62.4) dominate
 *   1d    4h x 6       52.9% (52.6-53.9) material
 *   1w    1d x 7       50.8% (50.7-51.4) small
 *
 * Intraday holds read "dominate" at taker fees, as the research program
 * measured; that is the intended result, not a calibration error.
 */
export const MATERIAL_WIN_RATE = 0.52;
export const DOMINANT_WIN_RATE = 0.55;

/** Below this many non-overlapping windows the move estimate is too thin for a verdict. */
export const MIN_INDEPENDENT_WINDOWS = 100;

export type CostTone = 'small' | 'material' | 'dominate' | 'exceed';

export const COST_TONE_LABEL: Record<CostTone, string> = {
  small: 'Costs small',
  material: 'Costs material',
  dominate: 'Costs dominate',
  exceed: 'Costs exceed the typical move',
};

/** Directional hit rate implied by an IC over every bar (bivariate normal). */
export function allBarsHitRate(ic: number): number {
  return 0.5 + Math.asin(ic) / Math.PI;
}

/** Directional hit rate implied by an IC on trades taken only at |z| = z. */
export function tailHitRate(ic: number, z = 2): number {
  return normalCdf(z * ic);
}

export function costTone(breakeven: Breakeven): CostTone {
  if (breakeven.kind === 'impossible') return 'exceed';
  if (breakeven.winRate > DOMINANT_WIN_RATE) return 'dominate';
  if (breakeven.winRate > MATERIAL_WIN_RATE) return 'material';
  return 'small';
}

/** The tone, or null when the move estimate rests on too few independent windows. */
export function costVerdict(breakeven: Breakeven, independentWindows: number): CostTone | null {
  if (independentWindows < MIN_INDEPENDENT_WINDOWS) return null;
  return costTone(breakeven);
}
