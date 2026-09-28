/**
 * Registry of the exploration families (session 19, 2026-09-28), kept apart
 * from `STRATEGY_FAMILIES` in strategy-families.ts.
 *
 * WHY A SECOND REGISTRY. Each exploration family lives in its own module
 * under `families/` and imports `StrategyFamily`, `currentAtr`,
 * `withLimitEntry` and `withManagement` from strategy-families.ts. If
 * strategy-families.ts imported those modules back to register them, the
 * import graph would be a cycle, and a test that loads a family module first
 * would evaluate the registry before the family's own binding exists. This
 * module sits above both: it imports strategy-families.ts and the family
 * modules, and the harness reads `ALL_FAMILIES` from here.
 *
 * The exploration regime these families run under (forward-rolling slices,
 * trial ledger, relaxed rulings) is recorded in the session 19 handover and
 * the ledger `.superpowers/sdd/2026-09-28-reddit-exploration/progress.md`.
 *
 * F6 `control-session` is not a family: it is the unchanged `control` family
 * run with the harness flag `--allowed-sessions <one session>` at 15m and 1h,
 * one run per session in `MARKET_SESSIONS` (`asia`, `london`, `ny_overlap`,
 * `new_york`, `off_hours`), so five runs per interval. The gate reaches the
 * walk-forward cells, the stress re-run and the random-entry benchmark alike
 * (see strategy-walk-forward.ts), which is what makes its timing p readable.
 */
import { STRATEGY_FAMILIES, type StrategyFamily } from './strategy-families';
import { vwapFadeFamily } from './families/vwap-fade';
import { valueAreaRejectionFamily } from './families/value-area-rejection';
import { sweepReclaimFamily, sweepReclaimLimitFamily } from './families/sweep-reclaim';
import { bosContinuationFamily } from './families/bos-continuation';
import {
  btcLeadlagContinuationFamily,
  btcLeadlagContinuationLimitFamily,
} from './families/btc-leadlag-continuation';
import { dvolSpikeLongFamily, dvolSpikeLongLimitFamily } from './families/dvol-spike-long';
import { skewSpikeLongFamily } from './families/skew-spike-long';
import {
  deltaFlowContinuationFamily,
  deltaFlowContinuationLimitFamily,
} from './families/delta-flow-continuation';
import { gammaRegimeReversalFamily } from './families/gamma-regime-reversal';

/**
 * The families added by the exploration, keyed by their CLI name. Round 1
 * (Reddit rule shapes on existing inputs) first, then round 2 (the Deribit
 * options input, motivated by the develop-slice IC triage: DVOL z, put-call
 * skew and signed delta flow).
 */
export const EXPLORATION_FAMILIES: Record<string, StrategyFamily> = {
  'vwap-fade': vwapFadeFamily,
  'value-area-rejection': valueAreaRejectionFamily,
  'sweep-reclaim': sweepReclaimFamily,
  'sweep-reclaim-limit': sweepReclaimLimitFamily,
  'bos-continuation': bosContinuationFamily,
  'btc-leadlag-continuation': btcLeadlagContinuationFamily,
  'btc-leadlag-continuation-limit': btcLeadlagContinuationLimitFamily,
  'dvol-spike-long': dvolSpikeLongFamily,
  'dvol-spike-long-limit': dvolSpikeLongLimitFamily,
  'skew-spike-long': skewSpikeLongFamily,
  'delta-flow-continuation': deltaFlowContinuationFamily,
  'delta-flow-continuation-limit': deltaFlowContinuationLimitFamily,
  'gamma-regime-reversal': gammaRegimeReversalFamily,
};

for (const name of Object.keys(EXPLORATION_FAMILIES)) {
  if (name in STRATEGY_FAMILIES) {
    throw new Error(`exploration family "${name}" collides with a STRATEGY_FAMILIES entry`);
  }
  if (EXPLORATION_FAMILIES[name].name !== name) {
    throw new Error(
      `exploration family registered as "${name}" names itself "${EXPLORATION_FAMILIES[name].name}"`
    );
  }
}

/** Every family the harness can run: the Phase 4 registry plus the exploration set. */
export const ALL_FAMILIES: Record<string, StrategyFamily> = {
  ...STRATEGY_FAMILIES,
  ...EXPLORATION_FAMILIES,
};
