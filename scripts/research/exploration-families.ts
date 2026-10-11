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
 *
 * REVIEW CAVEATS, 2026-10-01 (not re-run; see the full list in the header of
 * strategy-families.ts). Two bear on these tables in particular:
 *
 *  M2  The confirmation slices S1 to S4 (2023, 2024, 2025H1, 2025H2 to
 *      2026H1) are NOT clean holdouts for most families here. Phases 3 to B
 *      developed on every year to 2026-06-30, and btc-leadlag-continuation
 *      (Phase B's btcLeadLag), the session-gated control (control's per-year
 *      results were already known), vwap-fade and sweep-reclaim (Phase 3's
 *      intraday reversal) and the managed depth and positioning families
 *      (Phase 4c base cells) all descend from results on those years. Only
 *      the options families, whose Deribit input was ingested fresh and
 *      triaged on S0 alone, and the 2026-07-01 lockbox are clean. Every
 *      promoted candidate failed its first slice anyway, so this produced no
 *      false pass; it means S1 to S4 could not have certified one.
 *  M5  Under `--fix-params` a confirmation run has one cell, so the trials
 *      gate's deflated-Sharpe benchmark is computed from a grid variance of
 *      zero and the gate is vacuous there. The promotion rule (expectancy
 *      above zero, symbols at or above 0.6, no more than half the S0 value
 *      lost) did not read that gate. Also: "S1 2023" scores only the last
 *      55 to 60% of 2023, because the 0.4 train fraction still applies inside
 *      a fixed-parameter slice.
 *
 * ROUND 1 RESULTS (2026-09-28, develop slice S0 = everything before
 * 2023-01-01, which at 1h and 15m is 2021-10 to 2022-12 and at 4h from
 * 2018-10; dataset research-p4, hash 3f14b27e; trials 1141 as run (1186 on
 * the audited count, which flips no verdict); standard
 * profile with study slippage and funding; ten symbols, nine alts for the
 * lead-lag families because BTCUSDT's own column is NaN by design; six
 * rolling windows, train fraction 0.4, lockbox on; every report under
 * $HOME/reddit-out/r1/runs on the VPS). exp is pooled out-of-sample
 * expectancy per trade after costs, CI the bootstrap 95% interval, p the
 * random-entry p-value, sym the symbols with positive expectancy. Every run
 * FAILS the eight gates; `return-reversal` is the baseline the two
 * reversal-shaped families must beat to count as a new effect (they do not).
 *
 *   iv   family                          n     exp%     CI95                p      sym
 *   1h   vwap-fade                       750  -0.3754  [-0.9885,  0.1940]  0.950  1/10
 *   1h   value-area-rejection           1200  -0.4541  [-0.7759, -0.1887]  0.995  1/10
 *   1h   sweep-reclaim                  1229  -0.2429  [-0.4243, -0.0595]  0.736  0/10
 *   1h   sweep-reclaim-limit            3128  -0.1662  [-0.3092, -0.0291]  0.214  1/10
 *   1h   bos-continuation               1675  -0.1875  [-0.3887,  0.0102]  0.781  1/10
 *   1h   control-managed                2043  -0.0375  [-0.2475,  0.1622]  0.015  3/10
 *   1h   return-reversal (baseline)      684  -0.1009  [-0.4649,  0.2867]  0.080  6/10
 *   1h   control, asia                   819  +0.0319  [-0.2908,  0.3505]  0.259  4/10
 *   1h   control, london                 776  -0.1648  [-0.4923,  0.1700]  0.602  2/10
 *   1h   control, ny_overlap             768  -0.1050  [-0.4724,  0.2534]  0.557  4/10
 *   1h   control, new_york               819  +0.2010  [-0.1381,  0.5830]  0.065  6/10  promoted
 *   1h   control, off_hours              565  +0.1316  [-0.2362,  0.5514]  0.189  5/10
 *   1h   btc-leadlag-continuation       3630  -0.1507  [-0.2724, -0.0193]  0.244  1/9
 *   1h   btc-leadlag-continuation-limit 3450  -0.2055  [-0.3257, -0.0901]  0.925  0/9
 *   4h   vwap-fade                       714  -0.7173  [-1.4442,  0.0263]  0.960  0/10
 *   4h   value-area-rejection           1571  -0.2048  [-0.6087,  0.1911]  0.552  3/10
 *   4h   sweep-reclaim                  1042  -0.0283  [-0.3775,  0.3193]  0.100  3/10
 *   4h   sweep-reclaim-limit            2502  -0.1707  [-0.5058,  0.1326]  0.428  4/10
 *   4h   bos-continuation               1752  -0.3065  [-0.7927,  0.1991]  0.955  4/10
 *   4h   control-managed                 531  -0.0042  [-0.6441,  0.5681]  0.304  6/10
 *   4h   return-reversal (baseline)      777  -0.2268  [-1.2730,  1.1110]  0.532  2/10
 *   4h   btc-leadlag-continuation       2766  -0.1540  [-0.4448,  0.1408]  0.423  3/9
 *   4h   btc-leadlag-continuation-limit 2988  -0.1369  [-0.4191,  0.1506]  0.358  3/9
 *   15m  vwap-fade                      2381  -0.0937  [-0.2916,  0.0841]  0.020  3/10
 *   15m  value-area-rejection           2736  -0.1382  [-0.2301, -0.0516]  0.229  1/10
 *   15m  sweep-reclaim                  3808  -0.1518  [-0.2000, -0.1036]  0.264  0/10
 *   15m  sweep-reclaim-limit            9942  -0.0958  [-0.1377, -0.0539]  0.005  0/10
 *   15m  bos-continuation               3631  -0.1466  [-0.2008, -0.0879]  0.413  1/10
 *   15m  control-managed                6781  -0.1319  [-0.1831, -0.0829]  0.035  0/10
 *   15m  return-reversal (baseline)     3976  -0.1524  [-0.2213, -0.0808]  0.239  0/10
 *   15m  control, asia                  2044  -0.1119  [-0.2146, -0.0058]  0.328  1/10
 *   15m  control, london                1493  -0.2388  [-0.3481, -0.1215]  0.906  0/10
 *   15m  control, ny_overlap            1433  -0.1646  [-0.2992, -0.0347]  0.637  1/10
 *   15m  control, new_york              1529  -0.0910  [-0.2083,  0.0254]  0.279  1/10
 *   15m  control, off_hours             1098  +0.0037  [-0.1370,  0.1498]  0.065  5/10
 *   15m  btc-leadlag-continuation      10879  -0.1472  [-0.1920, -0.1030]  0.154  0/9
 *   15m  btc-leadlag-continuation-limit 9372  -0.1211  [-0.1714, -0.0706]  0.005  0/9
 *
 * Round 1 promotion: the New York session control at 1h met the S0 rule
 * (expectancy above zero, symbols at or above 0.6) and FAILED S1 (2023):
 * n 736 -0.1258% [-0.3205, 0.0674] p 0.493 symbols 4/10. Reading: the two
 * reversal-shaped families re-measure the known one-bar bounce and pay fees
 * for it; management makes the control worse; the lead-lag near miss does
 * not pay as a rule and its passive variant is worse (the fill arrives
 * after BTC's lead has reversed); a timing p that passes at 15m is a rule
 * whose entries are timed and whose round trip still eats them.
 *
 * ROUND 2 RESULTS (2026-09-28, the Deribit options input; same slice on the
 * options-enabled export research-p4o, hash 3483a511; the options rows begin
 * 2021-10-01, so the evaluated sample is 2021-10 to 2022-12 at every
 * interval, and at 4h the early windows are skipped for most symbols (27 to
 * 29 of 60 symbol-windows evaluated per run) because the column is NaN
 * before then; trials 1591 as run (1636 on the audited count); reports under
 * $HOME/reddit-out/r2). gates is the count failed of eight.
 *
 *   iv   family                          n     exp%     CI95                p      sym    gates
 *   1h   delta-flow-continuation         401  +1.7066  [ 0.3924,  3.1832]  0.005  10/10  2 (trials, plateau)
 *   1h   delta-flow-continuation-limit   414  +1.6900  [ 0.3573,  3.2503]  0.005  10/10  2 (trials, plateau)
 *   1h   dvol-spike-long                 445  -0.9159  [-2.2160,  0.4081]  0.970  1/10   7
 *   1h   dvol-spike-long-limit           414  -0.9951  [-2.3615,  0.4316]  0.980  0/10   7
 *   1h   skew-spike-long                4394  -0.2822  [-0.5144, -0.0544]  0.045  0/10   6
 *   1h   gamma-regime-reversal          1450  -0.1724  [-0.2900, -0.0689]  0.642  0/10   7
 *   4h   delta-flow-continuation         382  +1.8005  [ 0.0921,  3.5426]  0.005  10/10  3 (windows, trials, plateau)
 *   4h   delta-flow-continuation-limit   379  +1.9749  [ 0.0606,  4.0833]  0.005  10/10  3 (windows, trials, plateau)
 *   4h   dvol-spike-long                 296  -1.1864  [-3.3566,  0.7140]  0.970  1/10   7
 *   4h   dvol-spike-long-limit           277  -1.1562  [-3.3989,  0.8474]  0.970  1/10   7
 *   4h   skew-spike-long                1716  -0.6684  [-1.2946, -0.0306]  1.000  0/10   7
 *   4h   gamma-regime-reversal          1454  -0.1388  [-0.3211,  0.0376]  0.423  3/10   7
 *   15m  dvol-spike-long                1562  -0.3276  [-0.8092,  0.1041]  0.945  0/10   7
 *   15m  gamma-regime-reversal          3073  -0.1591  [-0.2105, -0.1061]  0.502  0/10   7
 *   15m  dvol-spike-long-limit          1379  -0.3743  [-0.9479,  0.1635]  0.965  0/10   7
 *   15m  delta-flow-continuation         980  +0.4357  [-0.1033,  0.9982]  0.005  10/10  3 (expectancy, trials, plateau)
 *   15m  skew-spike-long               20682  -0.1816  [-0.2344, -0.1277]  0.085  0/10   7
 *   15m  delta-flow-continuation-limit  1016  +0.5232  [ 0.0183,  1.0664]  0.005  10/10  2 (trials, plateau)
 *
 * Round 2 promotions, S1 = 2023, one fixed cell each (the most-selected S0
 * cell), all six FAIL: delta-flow-continuation 4h (z 1.5, k 3, hold 32)
 * n 228 -0.3469% [-1.8016, 1.3823] p 0.980 sym 3/10; delta-flow-continuation
 * 1h (z 2, k 3, hold 32) n 362 -0.6620% [-1.2572, 0.0267] p 0.995 sym 0/10;
 * delta-flow-continuation-limit 4h (timeout 1) n 227 -0.4473%
 * [-1.9149, 1.1433] p 0.970 sym 3/10; delta-flow-continuation-limit 1h
 * (timeout 1) n 363 -0.5824% [-1.1966, 0.0803] p 0.995 sym 0/10;
 * delta-flow-continuation 15m (z 2, k 3, hold 32) n 867 -0.4382%
 * [-0.6950, -0.1710] p 1.000 sym 0/10; delta-flow-continuation-limit 15m
 * (timeout 1) n 842 -0.3726% [-0.6372, -0.1071] p 1.000 sym 0/10. Six
 * promotions, six failures. The 1h and 15m rules fired at the same rate in
 * 2023 and lost on every symbol; the options rows are complete for 2023. A
 * record-only 2023 IC read of the delta-flow column alone (factors.ts
 * header, OPTIONS TRIAGE RESULTS) shows the column's relation to the next
 * 4 to 16 hours flipped sign between 2022 and 2023, so the develop slice
 * (one bear year, all the options history there is before 2023) fitted a
 * regime, not a rule. The DVOL and skew IC survivors do not translate into
 * long-only spike rules: the stop is hit inside the high-vol bars the drift
 * needs (win rates 0.37 to 0.43, payoff about 1.0).
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
import { LEGENDS_FAMILIES } from './families/legends';
import { DX_FAMILIES } from './families/direction-exit';

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

for (const name of Object.keys(LEGENDS_FAMILIES)) {
  if (name in STRATEGY_FAMILIES || name in EXPLORATION_FAMILIES) {
    throw new Error(`legends family "${name}" collides with an earlier registry entry`);
  }
}

for (const name of Object.keys(DX_FAMILIES)) {
  if (name in STRATEGY_FAMILIES || name in EXPLORATION_FAMILIES || name in LEGENDS_FAMILIES) {
    throw new Error(`direction-exit family "${name}" collides with an earlier registry entry`);
  }
}

/**
 * Every family the harness can run: the Phase 4 registry, the exploration set,
 * and the legends phase's six pre-registered single-cell rules
 * (families/legends.ts, run in fixed-evaluation mode), and the direction-exit
 * study's three families (families/direction-exit.ts).
 */
export const ALL_FAMILIES: Record<string, StrategyFamily> = {
  ...STRATEGY_FAMILIES,
  ...EXPLORATION_FAMILIES,
  ...LEGENDS_FAMILIES,
  ...DX_FAMILIES,
};
