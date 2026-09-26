import type { BacktestMetrics } from '@/lib/backtest/types';
import type { WalkForwardWindow } from '@/types/optimization';

/**
 * Session 04 handover: the first two templates ever created were saved from
 * a single contributing window with negative out-of-sample results, because
 * only the top-five ensemble documents survive a walk-forward run and
 * nothing checked how many windows actually produced an out-of-sample result
 * before saving. This gate refuses exactly that.
 */
export const SAVE_GATE = {
  minContributingWindows: 2,
};

export interface SaveGateResult {
  pass: boolean;
  reason: string | null;
  contributingWindows: number;
  avgOosExpectancyPercent: number | null;
}

/**
 * A window "contributes" when it produced an out-of-sample result at all
 * (oosMetrics is not null); a window skipped for lacking a robust in-sample
 * candidate does not. Passes only when enough windows contributed and their
 * mean out-of-sample expectancy is positive.
 */
export function passesSaveGate(windows: WalkForwardWindow[]): SaveGateResult {
  const contributing = windows.filter(
    (window): window is WalkForwardWindow & { oosMetrics: BacktestMetrics } =>
      window.oosMetrics !== null
  );
  const contributingWindows = contributing.length;

  if (contributingWindows < SAVE_GATE.minContributingWindows) {
    return {
      pass: false,
      reason: `Only ${contributingWindows} of ${windows.length} window(s) produced an out-of-sample result, need at least ${SAVE_GATE.minContributingWindows} contributing windows`,
      contributingWindows,
      avgOosExpectancyPercent: contributingWindows > 0
        ? contributing.reduce((sum, window) => sum + window.oosMetrics.expectancyPercent, 0) / contributingWindows
        : null,
    };
  }

  // contributingWindows >= SAVE_GATE.minContributingWindows (at least 2)
  // here, so at least one window contributed and this average is never null.
  const avgOosExpectancyPercent =
    contributing.reduce((sum, window) => sum + window.oosMetrics.expectancyPercent, 0) /
    contributingWindows;

  if (avgOosExpectancyPercent <= 0) {
    return {
      pass: false,
      reason: `Average out-of-sample expectancy across ${contributingWindows} windows is ${avgOosExpectancyPercent.toFixed(4)}%, not positive`,
      contributingWindows,
      avgOosExpectancyPercent,
    };
  }

  return {
    pass: true,
    reason: null,
    contributingWindows,
    avgOosExpectancyPercent,
  };
}
