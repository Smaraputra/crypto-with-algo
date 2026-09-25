/**
 * Factor IC study CLI: for one interval, measures every (or a chosen subset
 * of) factor against forward returns at several horizons, per symbol and
 * pooled, and writes a FactorIcReport (schema in report-schema.ts).
 *
 * Usage:
 *   npx tsx scripts/research/factor-ic.ts --interval 1h
 *   npx tsx scripts/research/factor-ic.ts --interval 5m --symbols BTCUSDT,ETHUSDT --factors raw.ret1,raw.rsi
 *   npx tsx scripts/research/factor-ic.ts --interval 1h --cell raw.ret1:4:BTCUSDT
 *
 * Reads a dataset exported by export-dataset.ts (via load-dataset.ts's
 * lockbox-aware loaders) and never touches Mongo.
 *
 * Phase 3 results (2026-09-18, dataset 3fdeac9e495e3051ad2e2c7553be6b07b1da0d7b9e84f468d635d2708c624782,
 * commit f7946f4, lockbox applied so every window ends 2026-06-30, ten
 * symbols, horizons 1,2,4,8,16,32, bootstrap 200 draws seed 42; reports
 * under data/research/reports/factor-ic-<interval>-p3.json, one random cell
 * per report re-run with --cell --report and reproduced digit for digit).
 * Survivor rule: pooled |ic| >= 0.02 and |t| >= 2.5 at two or more horizons,
 * same sign in 60% of quarters and in seven of ten symbols. Sign is the
 * sign of the pooled IC; "+" means a higher reading precedes a higher
 * forward return. Survivors per interval: 5m 21 of 30, 1h 18 of 40,
 * 4h 4 of 40, 1d 2 of 35.
 *
 *   factor              5m                1h              4h            1d
 *   composite           .                 - h8,16         .             .
 *   cat.trend           - h1-32           - h1-16         .             .
 *   sig.EMA Cross       - h1-32           - h1-16         .             .
 *   sig.SMA Trend       - h1-32           .               .             .
 *   sig.SuperTrend      - h1-16           - h2-16         .             .
 *   sig.Ichimoku        .                 - h1,2,4        .             .
 *   sig.MACD            - h1-32           .               .             .
 *   cat.htf, HTF sigs   - h8-32           .               .             .
 *   raw.emaSpreadPct    - h1-32           - h2-16         .             .
 *   cat.momentum        + h1,2,4          .               + h2,4        .
 *   sig.Williams %R     + h1-32           + h1,2,4        .             .
 *   sig.StochRSI        .                 .               + h2,4        .
 *   raw.rsi             - h1-32           - h1-8          .             .
 *   cat.volatility      + h1-32           + h1-8          .             .
 *   sig.Bollinger       + h1-32           + h1-8          .             .
 *   cat.volume          .                 - h1,2          .             .
 *   sig.OBV             - h1-16           - h1,2,4        .             .
 *   sig.Volume          - h1,2,4          .               .             .
 *   sig.Taker Flow      .                 - h1,2          .             .
 *   raw.takerBuyRatio   .                 - h1,2          .             .
 *   raw.longShortRatio  (no data)         - h4,8,32       .             - h4,8,32
 *   raw.ret1            - h1-8            - h1,2,4        - h1,2        - h1,2,4,32
 *   raw.ret5            - h1-32           - h1-8          - h1-8        .
 *   raw.ret20           - h1-32           - h1-32         .             .
 *
 * Reading: intraday (5m, 1h) every trend-following input, the composite
 * included, predicts with the wrong sign, and mean reversion dominates:
 * past returns, RSI, and buying pressure (OBV, Volume, Taker Flow, taker
 * buy ratio) precede lower returns, while oversold readings (Williams %R,
 * Bollinger lower band, which is the whole volatility category once ATR
 * is excluded) precede higher ones. Strongest cells: raw.rsi 5m h1
 * ic -0.046 t -39.6, cat.volatility 5m h2 ic 0.047 t 36.6, raw.ret5 5m h1
 * ic -0.043 t -35.3, cat.trend 5m h1 ic -0.032 t -27.1, raw.ret1 1h h1
 * ic -0.048 t -27.7. At 4h only short-horizon momentum (cat.momentum,
 * StochRSI) and 1 to 8 bar return reversal survive; at 1d only 1 bar
 * reversal and the long/short ratio (500-bar sample). The composite is
 * negative at 1h (h8 ic -0.022 t -6.5), positive but below the effect
 * floor at 5m h1,2 and at 4h, and uninformative at 1d. The contrarian
 * sentiment category is on the wrong side at 4h and 1d (t -3.7 to -5.0,
 * fails only on quarter agreement): the raw Fear & Greed index has a
 * positive IC at 1d (h8 ic 0.063 t 4.1). Effect sizes are small (pooled
 * |ic| 0.02 to 0.05) and measured before costs; whether any survives the
 * cost model is the Phase 4 harness question.
 *
 * Caveats: 5m and 15m now read the 1h snapshot file when one exists for the
 * symbol (mapToSnapshotInterval, the same mapping live scoring and
 * strategy-harness.ts use), rather than forcing snapshots null; that
 * divergence from live scoring was removed on 2026-09-19. The Phase 3 table
 * above predates the fix: its 5m column was measured with snapshots forced
 * null (cat.futures, cat.sentiment, raw.fundingRate, raw.longShortRatio,
 * raw.fearGreed skipped) and has not been re-run since. In the Phase 3
 * dataset long/short ratio and open interest covered only the last 500 bars
 * Binance REST would serve (11.0% of 1h bars, 6.9% at 4h and 1d, none before
 * 2026-03-03), so raw.longShortRatio in the table above was measured on about
 * four months under the lockbox and open interest never reached the scorer at
 * all. The factor matrix keeps Ichimoku at 5m where live scoring nulls it;
 * sig.ATR has no directional reading and is skipped everywhere.
 *
 * Archive inputs (Phase 3b). When the dataset carries the `metrics` and `perp`
 * kinds that scripts/ops/ingest-archive.ts and export-dataset.ts produce, this
 * CLI also measures raw.oiChange1, raw.oiChange8, raw.oiPriceDiv,
 * raw.takerLongShortRatio, raw.topTraderPositionRatio, raw.globalAccountRatio,
 * raw.fundingZ, raw.basisPct, raw.perpSpotSpreadPct, raw.depthImbalance1 and
 * raw.depthImbalance5. raw.longShortRatio is not new but its coverage is, so
 * it is effectively unmeasured too and belongs in the same re-run. A dataset
 * exported before those kinds existed still loads: the archive columns are
 * NaN throughout and land in skippedFactors rather than failing the run.
 *
 * PHASE 3B RESULTS, 2026-09-20. Dataset hash e84cd66dbe01..., lockbox
 * applied, 10 symbols, horizons 1,2,4,8,16,32, reports under
 * data/research/reports/factor-ic-<interval>-p3b.json. Same survivor rule as
 * Phase 3. Coverage after the archive backfill: longShortRatio 77.8% at 1h and
 * 48.7% at 4h/1d (the top-trader series starts in 2023; it is ~0% across 2022),
 * openInterest 95.6% and 59.8%, against 11.1% and 7.0% before. Survivors per
 * interval: 5m 24 of 50, 15m 27 of 51, 1h 19 of 51, 4h 10 of 51, 1d 7 of 46,
 * against Phase 3's 4 of 40 at 4h and 2 of 35 at 1d.
 *
 *   factor                      5m           15m          1h           4h           1d
 *   raw.longShortRatio          .            .            .            - h8-32      - h1-32
 *   raw.topTraderPositionRatio  .            .            .            - h8-32      - h1-32
 *   raw.globalAccountRatio      .            .            .            - h8-32      - h1-32
 *   sig.Long/Short Ratio        .            .            .            + h8-32      + h1-32
 *   cat.futures                 .            .            .            .            + h8,32
 *   raw.depthImbalance1         .            .            .            - h4-32      - h1-32
 *   raw.depthImbalance5         .            .            + h1,2       .            .
 *   raw.fundingZ                - h16,32     - h8-32      - h8,16      - h2,4       .
 *   raw.perpSpotSpreadPct       + h1-8       + h1-4       .            .            .
 *
 * Reading: positioning is the finding. At 4h and 1d a higher top-trader
 * long/short ratio precedes LOWER forward returns across every horizon
 * measured, and the effect is the largest the program has seen: 1d h32
 * ic -0.218 t -5.9 n 12,906, 4h h32 ic -0.078 t -4.9 n 79,049. Phase 3 did
 * flag long/short at 1d, but on the ~500 bars Binance REST would serve; this
 * is 3.5 years across ten symbols. Order-book depth imbalance at +/-1% runs
 * the same way (1d h32 ic -0.101 t -5.2), and the composite's futures
 * category comes alive at 1d (h8 ic 0.035 t 2.5) where it had almost no data
 * before. Funding, z-scored over 30 days, is a consistent contrarian signal
 * from 5m to 4h (1h h8 ic -0.024 t -7.1 n 410,159) and dies at 1d. Note
 * raw.longShortRatio and raw.topTraderPositionRatio are the SAME series by
 * construction (src/lib/archive-ingestion.ts fills the snapshot field from the
 * archive's top-trader position ratio, matching the live path), so they are
 * one finding, not two; sig.Long/Short Ratio is the scorer's own signal on
 * that input and its "+" is the same information under the opposite sign
 * convention. The intraday mean-reversion picture from Phase 3 is unchanged.
 *
 * raw.perpSpotSpreadPct IS AN ARTIFACT, confirmed by the lag-1 re-run below.
 * It is (perp close - spot close) / spot close, and the forward return is
 * (spot close[t+h] - spot close[t]) / spot close[t], so the two share
 * spot close[t]: noise in that one print pushes both up together, which is
 * the classic bid-ask bounce correlation. The evidence that this is what is
 * happening: raw.basisPct measures essentially the same economic quantity
 * from the premium index, an independent series sharing no term with the
 * forward return, and it tracks the same shape at about 40% of the magnitude
 * at every interval (5m h1 ic 0.027 t 23.2 against 0.069 t 61.0; 1h 0.003
 * against 0.016), while both decay to nothing by 4h. The fix is to measure
 * perp factors against forward returns computed on PERP closes, which is also
 * the venue the cost model charges; until then no family should be built on
 * this column. raw.basisPct itself does not survive anywhere (5m fails symbol
 * agreement at 0.50).
 *
 * EXECUTION LAG, 2026-09-20. Every interval was re-run with
 * --execution-lag 1, which measures the forward return from the next close
 * instead of the one the factor is read at. That is what a rule acting on the
 * signal could actually get, and it removes any price term shared between a
 * factor and its own return. Reports are the same names with a -lag1 suffix.
 *
 *   interval  survivors      positioning lag0 -> lag1        raw.ret1 h1 lag0 -> lag1
 *   5m        24 -> 22       -0.0059 t-2.4 -> -0.0059 t-2.4  -0.0299 t-24.5 -> -0.0231 t-19.0
 *   15m       27 -> 20       -0.0238 t-3.0 -> -0.0235 t-3.0  -0.0565 t-29.2 -> -0.0121 t -6.3
 *   1h        19 -> 15       -0.0327 t-4.1 -> -0.0328 t-4.1  -0.0476 t-27.7 -> -0.0291 t-17.1
 *   4h        10 ->  7       -0.0783 t-4.9 -> -0.0783 t-4.9  -0.0451 t-16.0 -> -0.0157 t -5.6
 *   1d         7 ->  4       -0.2177 t-5.9 -> -0.2194 t-5.9  -0.0474 t -6.5 -> -0.0085 t -1.2
 *
 * This splits the study in two. Positioning is untouched, to four significant
 * figures at every interval: it is a slow variable that has nothing to do with
 * the print the return is measured from. Short-horizon return reversal loses
 * a large part of its effect everywhere, between 23% at 5m and 82% at 1d
 * (79% at 15m, 40% at 1h, 65% at 4h; the size does not fall neatly with the
 * interval, so read it as "materially smaller everywhere" rather than as a
 * gradient). cat.volume, sig.OBV, sig.Taker Flow and raw.takerBuyRatio all
 * stop surviving at 1h, and raw.ret1 stops surviving at 1d.
 *
 * The artifact call above is now settled rather than suspected.
 * raw.perpSpotSpreadPct at 5m h1 goes from ic 0.0689 t 61.0, the largest
 * single cell anywhere in this program, to ic -0.0015 t -1.3 once the return
 * starts one bar later. It was the shared spot close, entirely.
 *
 * The Phase 3 headline that intraday mean reversion dominates therefore needs
 * a qualifier that was not in it: roughly half of that effect is the bid-ask
 * bounce, not a tradeable reversal. It does not overturn the conclusion, since
 * Phase 4 already found nothing there that paid its costs, but any future
 * measurement on this dataset should run at lag 1, and the lag-0 numbers in
 * the tables above are kept only for continuity with Phase 3.
 *
 * THE LAG-1 SURVIVOR TABLE. Every table above this point is lag 0, which the
 * program has since ruled superseded, so this is the one to read. Generated
 * from data/research/reports/factor-ic-<interval>-p3b-lag1.json with the
 * repository's own SURVIVOR_RULE (report-schema.ts), and its per-interval
 * counts reproduce the ones recorded above: 5m 22 of 50, 15m 20 of 51,
 * 1h 15 of 51, 4h 7 of 51, 1d 4 of 46.
 *
 *   factor                      5m          15m         1h          4h          1d
 *   cat.htf                     - h8-32     - h16,32    .           .           .
 *   cat.trend                   - h1-32     - h4-32     - h2-16     .           .
 *   cat.volatility              + h1-16     + h2,4      + h1-4      .           .
 *   composite                   .           - h8-32     - h8,16     .           .
 *   raw.depthImbalance1         .           .           - h16,32    - h8-32     .
 *   raw.emaSpreadPct            - h1-32     - h4-32     - h2-16     .           .
 *   raw.fundingRate             - h16,32    - h16,32    .           .           .
 *   raw.fundingZ                - h16,32    - h8-32     - h8,16     .           .
 *   raw.globalAccountRatio      .           .           .           - h8-32     - h1-32
 *   raw.htfTrend                - h16,32    - h8-32     .           .           .
 *   raw.longShortRatio          .           .           .           - h8-32     - h1-32
 *   raw.ret1                    - h1-4      .           - h1-4      .           .
 *   raw.ret20                   - h1-32     - h16,32    - h4-32     .           .
 *   raw.ret5                    - h1-16     - h2-8      - h1-4      - h1-8      .
 *   raw.rsi                     - h1-32     - h2-32     - h1-8      .           .
 *   raw.topTraderPositionRatio  .           .           .           - h8-32     - h1-32
 *   sig.Bollinger               + h1-16     + h2,4      + h1-4      .           .
 *   sig.EMA Cross               - h1-32     - h4-32     - h2-16     .           .
 *   sig.HTF EMA Cross           - h16,32    - h16,32    .           .           .
 *   sig.HTF SMA Trend           - h8-32     - h16,32    .           .           .
 *   sig.HTF SuperTrend          - h16,32    - h16,32    .           .           .
 *   sig.Ichimoku                .           - h2-32     - h2,4      .           .
 *   sig.Long/Short Ratio        .           .           .           + h8-32     + h1-32
 *   sig.MACD                    - h4-16     .           .           .           .
 *   sig.OBV                     - h2-16     .           .           .           .
 *   sig.SMA Trend               - h1-32     - h4-32     .           .           .
 *   sig.StochRSI                .           .           .           + h2,4      .
 *   sig.SuperTrend              - h2-16     - h16,32    - h4-16     .           .
 *   sig.Volume                  - h2,4      .           .           .           .
 *   sig.Williams %R             + h1-16     + h2,4      + h1,2      .           .
 *
 * Three things in the lag-0 Phase 3b write-up do NOT survive here and must not
 * be built on: cat.futures at 1d, raw.fundingZ at 4h, and raw.depthImbalance1
 * at 1d (it clears the ic and t legs there but fails sign agreement).
 * raw.basisPct and raw.perpSpotSpreadPct survive nowhere at either lag.
 *
 * EXECUTION LAG IS MEASURED HERE BUT NOT IN THE BACKTEST. The bar loop fills a
 * market entry at the DECISION bar's own close (src/lib/backtest/bar-loop.ts),
 * which is lag 0. For a snapshot-derived factor that is still honest, because
 * buildSnapshotSeries pins each bar to a snapshot whose capture window closed
 * before the bar opened, so the reading precedes the fill. (That rule was
 * "stamped at or before the bar's open" until 2026-09-25, which was not the
 * same thing: the ingest cron stamps a reading back to the interval it floors
 * into, so a row stamped 12:00 held 12:45 data. Every snapshot-derived IC
 * recorded before that date was measured on the looser join.) For a factor derived from the bar's own
 * close -- raw.ret1, raw.ret5, rsi, the composite -- it is not: the rule acts
 * on a close it transacts at. Every recorded Phase 4 number for a
 * candle-derived family (control, return-reversal, oscillator-reversion) rests
 * on that assumption, and the lag-1 re-run above is what shows the size of it:
 * raw.ret1 h1 loses between 23% and 82% of its effect once the return starts
 * one bar later. Those families' timing p-values are correspondingly
 * optimistic. Positioning's numbers are not affected, which is why they stand.
 * Research columns derived from a close-aligned source are shifted forward one
 * bar by their producer for exactly this reason; see research-columns.ts.
 *
 * What this does NOT establish: that any of it pays costs. Phase 3 found 18
 * survivors at 1h and Phase 4 still found no family that beat the round trip.
 * What is different here is the horizon. These are 4h-to-daily signals, where
 * the cost drag per signal is a fraction of what it is on the 5m mean-reversion
 * cells that dominated Phase 3, so the Phase 4b question is genuinely open
 * rather than already answered. raw.topTraderPositionRatio at 1h flipped from
 * surviving to not surviving on a trivial re-export, so it is borderline there
 * and should not be leaned on.
 *
 * Phase 4b answered that question and the answer is no: see the header of
 * scripts/research/strategy-families.ts. Two rule shapes on the positioning
 * finding, at 1d and 4h, all four runs failing, with a random-entry timing p
 * between 0.07 and 0.70. The relationship is real and robust and still does
 * not convert into an edge.
 *
 * bootstrapCi95 is a fixed-rank block bootstrap of the IC: ranks are
 * computed once per (sub)sample (ic-stats.ts's standardizedRankProducts),
 * not recomputed inside every resample, and only the resulting per-pair
 * products are block-bootstrapped (bootstrapCiOfMean). This is an
 * approximation -- a resample's "true" rank correlation would re-rank its
 * own resampled values -- but a standard one at this sample size: re-ranking
 * on every resample (ic-stats.ts's own bootstrapCi, still available there,
 * unused by this CLI) was measured at roughly 21 seconds per gated cell at
 * this file's maxPairs/iterations defaults; see the C3 report's fix-round 2
 * entry for the fixed-rank measurement and the round 1 entry for the
 * re-ranking one.
 *
 * Memory and wall time at 5m scale (10 symbols x ~105,000 bars each):
 * - The forward-return cache (fwdFor) is a Float64Array per (symbol,
 *   horizon), not a (number | null)[]: at 10 symbols x 6 default horizons x
 *   105,000 bars, a boxed (number | null)[] cache measured 144.2 MB on the
 *   V8 heap (each element boxed once `null` appears anywhere in the array,
 *   which disqualifies V8's packed-double fast path); the Float64Array
 *   version measured ~48.1 MB, and critically, entirely OFF the V8 heap (in
 *   ArrayBuffer/external memory, not subject to V8's heap-size limits or
 *   its GC the same way). Measured directly against these two
 *   representations at this exact shape, not against the whole CLI.
 * - Wall time: computeFactorMatrix itself (indicator + composite scoring,
 *   all factors) measured 0.0112ms/bar on a 10,000-bar 1h fixture, which
 *   extrapolates linearly to about 12s for 10 symbols x 105,000 bars.
 *   icWithHac/icNonOverlapping/signHitRate/quantileSpread together measured
 *   174ms per (factor, horizon) at a single symbol's 105,000 rows and 2.1s
 *   per (factor, horizon) at the ~1.05M-row pooled scale. Across every
 *   factor this style/interval combination discovers (measured 38 for a
 *   day_trading/1h fixture) at the default 6 horizons, that extrapolates to
 *   roughly 400s (per-symbol) + 470s (pooled) + rolling-quarterly and the
 *   gated bootstrap (small in comparison, seconds to low tens of seconds
 *   given the ~0.3s/gated-cell figure above) -- on the order of 15-18
 *   minutes for a full, unrestricted run. Restricting --factors to a
 *   curated subset (as every test fixture in this file's test suite does)
 *   reduces this proportionally; see the C3 report's fix-round entry for
 *   the benchmark methodology and raw numbers.
 *
 * STAGE 1 OF THE NEW-FACTOR PHASE, 2026-09-25. Dataset e84cd66dbe01, lockbox
 * applied, ten symbols, execution lag 1. Three columns built from
 * `depthNotional1` and `depthNotional5`, which export-dataset.ts has always
 * written into MetricsRow and which no factor had ever read. Controls
 * reproduce the recorded lag-1 table exactly: raw.ret1 h1 is -0.0231 at 5m and
 * -0.0121 at 15m, and raw.depthImbalance1 at 4h is h8 -0.0269 t-4.9, h16
 * -0.0408 t-5.8, h32 -0.0515 t-5.7, which is what makes the new rows readable.
 *
 * NOTHING SURVIVES, at any interval, and the pre-registered kill criterion
 * fires: the phase ends with no harness run.
 *
 *   factor              5m best        1h best        4h best        verdict
 *   raw.depthFlow1      +0.0092 t+8.0  +0.0073 t+4.3  -0.0074 t-2.7  |ic| below the 0.02 floor
 *   raw.depthNotional1  +0.0127 t+2.6  -0.0027 t-1.3  +0.0026 t+0.4  quarter agreement 0.45 at 15m
 *   raw.depthSlope      -0.0118 t-2.4  +0.0076 t+2.0  +0.0049 t+1.2  nothing anywhere
 *
 * THE SIGN PREDICTION FOR FLOW WAS RIGHT, AND THE SIZE WAS NOT. depthFlow1 is
 * positive at the fast horizons, opposite to depthImbalance1's contrarian
 * reading, exactly as pre-registered: a crowded book LEVEL is faded, while the
 * FLOW that builds it is followed. It decays monotonically with horizon and
 * flips negative by 4h, which is coherent rather than noisy -- flow predicts
 * continuation over minutes and the crowding it creates reverts over hours.
 * With t+8.0 on the 5m pool this is a real effect, and at |ic| 0.0092 against a
 * 0.02 floor it is roughly half the size the rule demands.
 *
 * depthNotional1 and depthSlope were both pre-registered as expected
 * non-survivors and both are. The 15m notional reading (h16 +0.0248, h32
 * +0.0337, symbol agreement 0.80) fails on QUARTER agreement at 0.45, which is
 * the signature of a non-stationary level rather than a forecast: it works
 * across symbols and not across time. The program already learned this on
 * positioning and answered it with a trailing z within symbol. A z-scored depth
 * notional is therefore the obvious next column, and it is deliberately NOT
 * added here, because choosing it after seeing this result is what inflates a
 * search. It belongs in the next pre-registration.
 *
 * A METHODOLOGICAL CORRECTION MADE MID-PHASE, recorded because it changed the
 * intervals measured. The phase was pre-registered to measure 5m and 15m first,
 * on the grounds that the per-trade statistical bar is smallest there (0.010%
 * at 5m against 0.450% at 4h). That reasoning was wrong: it compares bars in
 * percent per trade while COST IS FIXED at about 0.040% a round trip and the
 * return a trade can earn scales with holding period. Restating both barriers
 * as a required information coefficient, ic = bar / (2 * sd per trade):
 *
 *   interval  sd%/trade  ic to pay cost  ic detectable  binding
 *   5m        0.71       0.0282          0.0070         cost
 *   1h        4.56       0.0044          0.0113         sample
 *   4h        8.12       0.0025          0.0277         sample
 *
 * 1h needs the SMALLEST ic, 0.0113, and is the only interval where anything
 * detectable is also tradable; 5m and 4h each carry a band of effects that can
 * be seen but not traded, or traded but not proven. So 1h and 4h were measured
 * after 5m and 15m, which means those two intervals were chosen with the result
 * of the first two already visible and must be counted as such. At 1h
 * depthFlow1 needs 0.0113 and delivers 0.0073: short by about 1.6x, and the
 * closest this program has come at a fine interval.
 *
 * STAGE 2, 2026-09-25. Same dataset and lag, measured at 5m, 1h AND 4h in one
 * pass so no interval was chosen after seeing another's result. Controls
 * reproduce the recorded lag-1 table exactly at all three: raw.ret1 h1 is
 * -0.0231 at 5m, -0.0291 at 1h and -0.0157 at 4h.
 *
 * BOTH DIRECT PREDICTIONS HELD, AND THE CONDITIONING HYPOTHESIS IS FALSIFIED.
 *
 * `raw.varianceRatio` is not a survivor at any interval, as pre-registered: a
 * regime reading is not a direction. `raw.fundingProximity` is not a survivor
 * either, and is strictly WEAKER than the plain `raw.fundingZ` it was built
 * from at every interval (1h h8: -0.0170 against -0.0234; 4h: about zero
 * against -0.0152). Weighting funding by distance to its settlement destroys
 * signal rather than adding it, so the event-time axis contributes nothing and
 * the funding level alone remains the better column.
 *
 * The pre-registered falsification was that if the TREND subset's reversal IC
 * is as negative as the MEAN-REVERSION subset's, the ratio is mis-signed or
 * measuring nothing. It fires, and the way it fires is the useful part:
 *
 *   interval  h   uncond    revert    trend     gap as % of uncond  direction
 *   5m        2   -0.0261   -0.0229   -0.0327   38%                 TREND deeper
 *   5m        4   -0.0245   -0.0223   -0.0289   27%                 TREND deeper
 *   1h        1   -0.0291   -0.0302   -0.0270   11%                 revert deeper
 *   1h        2   -0.0268   -0.0271   -0.0260    4%                 revert deeper
 *   4h        4   +0.0030   +0.0123   -0.0125   828%                TREND deeper
 *
 * The direction is INCONSISTENT across intervals: trend-deeper at 5m and 4h,
 * revert-deeper at 1h, and at 1h every gap is at or below the one-third
 * threshold fixed in advance. A conditioner that points one way at 5m, the
 * other at 1h, and back again at 4h is not measuring a stable regime.
 *
 * The likeliest reading, and it is consistent with what the program already
 * knows: a high variance ratio means the recent past TRENDED, and Phase 3
 * established that trend-following inputs are wrong-signed intraday. So the
 * ratio is picking up recent momentum, which is already contrarian and already
 * carried by raw.ret1 and the momentum columns. It adds nothing orthogonal.
 *
 * `raw.ret1InMeanReversion` and `raw.ret1InTrend` DO clear the survivor rule at
 * 5m and 1h, and that must not be read as a finding: they are subsets of
 * raw.ret1, which clears it too. They are diagnostics, not new inputs.
 *
 * ONE RESIDUE, deliberately not chased. At 4h the split produces a genuine SIGN
 * FLIP rather than a magnitude difference (h4 revert +0.0123, trend -0.0125).
 * That is a different claim from the one tested here and 4h is the
 * sample-limited interval, so acting on it would mean flipping a hypothesis
 * after seeing the data. It belongs in a new pre-registration or nowhere.
 *
 * PHASE CONSEQUENCE: Stage 4's gate was that Stages 0 to 2 produce at least one
 * factor surviving at a fine interval. No NEW input did. The gate stays shut and
 * the trade-level ingest -- roughly 232 GB, a streaming parser with no
 * precedent in the codebase, and about 17 files -- is not started. The cheap
 * stages did their job, which was to be cheap enough to say no with.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { mapToSnapshotInterval } from '@/lib/backtest/snapshot-series';
import {
  bootstrapCiOfMean,
  forwardReturns,
  icNonOverlapping,
  icWithHac,
  nonOverlappingIndices,
  quantileSpread,
  rollingByQuarter,
  signHitRate,
  standardizedRankProducts,
} from './ic-stats';
import { computeFactorMatrix, type FactorMatrix } from './factors';
import {
  loadCandles,
  loadHtf,
  loadManifest,
  loadMetrics,
  loadPerp,
  loadSnapshots,
  verifyManifest,
} from './load-dataset';
import {
  evaluateSurvivors,
  validateFactorIcReport,
  type FactorIcReport,
  type FactorReport,
  type HorizonStat,
} from './report-schema';
import type { MetricsRow, PerpCandleRow, SnapshotRow } from './dataset-format';

const DEFAULT_HORIZONS = [1, 2, 4, 8, 16, 32];
// Matches icWithHac/icNonOverlapping/spearman's own minimum-pairs threshold
// (fewer pairs than this and those functions already return NaN).
const MIN_PAIRS = 3;
// Pooled bootstrapCi95 is only attempted for cells whose pooled HAC |icT|
// clears this gate -- a candidate for the survivor rule (SURVIVOR_RULE.minT
// is 2.5; this gate is deliberately its own, slightly looser, constant).
// Cells below it carry bootstrapCi95: null rather than paying for a wide
// interval on a cell nobody will treat as a finding.
const BOOTSTRAP_GATE_ABS_T = 2;
// Upper bound on how many (factor, forward-return) rows feed one bootstrapCi
// call; see subsampleForBootstrap below for how a larger pooled series is
// reduced to this size.
const DEFAULT_BOOTSTRAP_MAX_PAIRS = 100_000;

export interface FactorIcArgs {
  interval: string;
  symbols?: string[];
  horizons: number[];
  start?: number;
  end?: number;
  datasetDir: string;
  out: string;
  taskId: string;
  bootstrapN: number;
  bootstrapSeed: number;
  bootstrapPerSymbol: boolean;
  bootstrapMaxPairs: number;
  /**
   * Bars between the bar a factor is read on and the entry its forward return
   * is measured from. 0 reproduces Phase 3; 1 is the tradeable reading and
   * removes any shared price term between a factor and its own return.
   */
  executionLagBars: number;
  allowLockbox: boolean;
  factors?: string[];
  cell?: { factor: string; horizon: number; symbol?: string };
  /** Abort if the loaded dataset's manifest.datasetHash does not equal this. */
  expectManifestHash?: string;
  /**
   * --cell only: a FactorIcReport file whose symbols/window/lockbox setting
   * this cell run must reproduce exactly (see runCell). --symbols/--start/
   * --end/--allow-lockbox are ignored when this is set.
   */
  reportPath?: string;
}

export interface CellResult {
  factor: string;
  horizon: number;
  symbol?: string;
  ic: number;
  n: number;
}

function parseList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseIntList(value: string): number[] {
  return parseList(value).map((s) => {
    const n = Number(s);
    // Non-positive horizons are rejected here, not left to fail downstream:
    // nonOverlappingIndices(n, h<=0) would otherwise loop forever (i += h
    // never advances past 0, or moves backward for a negative h).
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`Invalid horizon in --horizons: "${s}" (must be a positive integer)`);
    }
    return n;
  });
}

function parseIsoFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid --${name} date: ${value}`);
  }
  return ms;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function defaultTaskId(interval: string, now: Date): string {
  const stamp =
    `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}` +
    `${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}`;
  return `factor-ic-${interval}-${stamp}`;
}

function parseCell(value: string): { factor: string; horizon: number; symbol?: string } {
  const parts = value.split(':');
  if (parts.length === 2) {
    const [factor, horizonStr] = parts;
    const horizon = Number(horizonStr);
    if (!factor || !Number.isFinite(horizon)) {
      throw new Error(`Invalid --cell value: ${value}, expected factor:horizon[:symbol]`);
    }
    return { factor, horizon };
  }
  if (parts.length === 3) {
    const [factor, horizonStr, symbol] = parts;
    const horizon = Number(horizonStr);
    if (!factor || !Number.isFinite(horizon) || !symbol) {
      throw new Error(`Invalid --cell value: ${value}, expected factor:horizon[:symbol]`);
    }
    return { factor, horizon, symbol };
  }
  throw new Error(`Invalid --cell value: ${value}, expected factor:horizon[:symbol]`);
}

// These two flags are presence-only switches (no following value), unlike
// every other flag in this CLI.
const BOOLEAN_FLAGS = new Set(['allow-lockbox', 'bootstrap-per-symbol']);

// Every flag that takes a following value. An unrecognized --flag is
// rejected rather than silently absorbed as a no-op (and its value token
// silently swallowed) so a typo fails loudly instead of quietly doing
// nothing.
const VALUE_FLAGS = new Set([
  'interval',
  'symbols',
  'horizons',
  'start',
  'end',
  'dataset-dir',
  'out',
  'task-id',
  'bootstrap-n',
  'bootstrap-seed',
  'bootstrap-max-pairs',
  'execution-lag',
  'factors',
  'cell',
  'expect-manifest-hash',
  'report',
]);

/** Pure CLI argument parsing. `now` is injectable so default-taskId tests are deterministic. */
/** --execution-lag: a non-negative integer number of bars. */
function parseExecutionLag(raw: string | undefined): number {
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--execution-lag must be a non-negative integer, got "${raw}"`);
  }
  return Number(raw);
}

export function parseArgs(argv: string[], now: Date = new Date()): FactorIcArgs {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      booleans.add(key);
      continue;
    }
    if (!VALUE_FLAGS.has(key)) {
      throw new Error(`Unknown flag --${key}`);
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`Missing value for --${key}`);
    }
    flags.set(key, value);
    i++;
  }

  const interval = flags.get('interval');
  if (!interval) {
    throw new Error('--interval is required');
  }

  const taskId = flags.get('task-id') ?? defaultTaskId(interval, now);
  const out = flags.get('out') ?? `data/research/reports/factor-ic-${interval}-${taskId}.json`;

  return {
    interval,
    symbols: flags.has('symbols') ? parseList(flags.get('symbols')!) : undefined,
    horizons: flags.has('horizons') ? parseIntList(flags.get('horizons')!) : [...DEFAULT_HORIZONS],
    start: parseIsoFlag(flags.get('start'), 'start'),
    end: parseIsoFlag(flags.get('end'), 'end'),
    datasetDir: flags.get('dataset-dir') ?? 'data/research',
    out,
    taskId,
    bootstrapN: flags.has('bootstrap-n') ? Number(flags.get('bootstrap-n')) : 200,
    bootstrapSeed: flags.has('bootstrap-seed') ? Number(flags.get('bootstrap-seed')) : 42,
    bootstrapPerSymbol: booleans.has('bootstrap-per-symbol'),
    bootstrapMaxPairs: flags.has('bootstrap-max-pairs')
      ? Number(flags.get('bootstrap-max-pairs'))
      : DEFAULT_BOOTSTRAP_MAX_PAIRS,
    executionLagBars: parseExecutionLag(flags.get('execution-lag')),
    allowLockbox: booleans.has('allow-lockbox'),
    factors: flags.has('factors') ? parseList(flags.get('factors')!) : undefined,
    cell: flags.has('cell') ? parseCell(flags.get('cell')!) : undefined,
    expectManifestHash: flags.get('expect-manifest-hash'),
    reportPath: flags.get('report'),
  };
}

/** One symbol's factor matrix; also read by scripts/research/score-percentiles.ts. */
export interface SymbolData {
  symbol: string;
  matrix: FactorMatrix;
  lockboxApplied: boolean;
}

function inRange(t: number, start: number | undefined, end: number | undefined): boolean {
  if (start !== undefined && t < start) return false;
  if (end !== undefined && t > end) return false;
  return true;
}

export function loadSymbolData(
  datasetDir: string,
  symbol: string,
  interval: string,
  opts: { allowLockbox: boolean; start?: number; end?: number }
): SymbolData {
  const candleResult = loadCandles(datasetDir, symbol, interval, { allowLockbox: opts.allowLockbox });
  const htfResult = loadHtf(datasetDir, symbol, interval, { allowLockbox: opts.allowLockbox });

  const candles = candleResult.rows.filter((r) => inRange(r.t, opts.start, opts.end));
  const htf = htfResult.rows.filter((r) => inRange(r.t, opts.start, opts.end));

  // Same invariant computeFactorMatrix itself checks (belt and suspenders:
  // a misalignment here is a bug in this loader's own filtering, a
  // misalignment there is a bug in whatever calls computeFactorMatrix).
  if (htf.length !== candles.length) {
    throw new Error(
      `Candle/HTF row count mismatch for ${symbol} ${interval}: ${candles.length} candles vs ${htf.length} htf rows`
    );
  }
  for (let i = 0; i < candles.length; i++) {
    if (htf[i].t !== candles[i].t) {
      throw new Error(
        `Candle/HTF timestamp misalignment for ${symbol} ${interval} at index ${i}: candle t=${candles[i].t}, htf t=${htf[i].t}`
      );
    }
  }

  // Snapshots are only ingested at 1h/4h/1d (export-dataset.ts's
  // SNAPSHOT_INTERVALS); finer intervals read the mapped interval's file,
  // exactly as live scoring (buildSnapshotSeries) and strategy-harness.ts do.
  const snapshotInterval = mapToSnapshotInterval(interval);
  const snapshotPath = join(datasetDir, 'snapshots', symbol, `${snapshotInterval}.jsonl.gz`);
  let snapshots: SnapshotRow[] | null = null;
  if (existsSync(snapshotPath)) {
    snapshots = loadSnapshots(datasetDir, symbol, snapshotInterval, { allowLockbox: opts.allowLockbox }).rows.filter(
      (r) => inRange(r.t, opts.start, opts.end)
    );
  } else {
    console.error(`[factor-ic] ${symbol}: no ${snapshotInterval} snapshot file, snapshots=null`);
  }

  // Archive inputs (scripts/ops/ingest-archive.ts). Each is optional and
  // absent on a dataset exported before those kinds existed, in which case
  // every factor derived from it is NaN for the whole series rather than an
  // error: an older dataset still measures exactly what it always measured.
  const metricsPath = join(datasetDir, 'metrics', symbol, '5m.jsonl.gz');
  let metrics: MetricsRow[] | null = null;
  if (existsSync(metricsPath)) {
    metrics = loadMetrics(datasetDir, symbol, { allowLockbox: opts.allowLockbox }).rows.filter((r) =>
      inRange(r.t, opts.start, opts.end)
    );
  } else {
    console.error(`[factor-ic] ${symbol}: no futures metrics file, archive factors are NaN`);
  }

  const perp = loadPerpSeries(datasetDir, symbol, interval, 'klines', opts);
  const premiumIndex = loadPerpSeries(datasetDir, symbol, interval, 'premiumIndex', opts);

  const matrix = computeFactorMatrix({
    candles,
    snapshots,
    htf,
    interval,
    metrics,
    perp,
    premiumIndex,
  });

  return { symbol, matrix, lockboxApplied: !opts.allowLockbox };
}

/** One perpetual series, or null when the dataset has no file for it. */
function loadPerpSeries(
  datasetDir: string,
  symbol: string,
  interval: string,
  series: 'klines' | 'premiumIndex' | 'markPrice',
  opts: { allowLockbox: boolean; start?: number; end?: number }
): PerpCandleRow[] | null {
  const fileName = series === 'klines' ? `${interval}.jsonl.gz` : `${interval}.${series}.jsonl.gz`;
  if (!existsSync(join(datasetDir, 'perp', symbol, fileName))) return null;
  return loadPerp(datasetDir, symbol, interval, series, {
    allowLockbox: opts.allowLockbox,
  }).rows.filter((r) => inRange(r.t, opts.start, opts.end));
}

// Number of equal strata the pooled series is split into when it needs
// subsampling for the bootstrap; see subsampleForBootstrap.
const SUBSAMPLE_BLOCK_COUNT = 20;

/** mulberry32: same small seeded PRNG as ic-stats.ts's own (unexported) one, reimplemented locally for the subsample below. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically picks at most maxLen indices out of [0, len) as
 * SUBSAMPLE_BLOCK_COUNT contiguous blocks, one per equal stratum of the
 * range, each at a seeded-random offset within its stratum. Each block
 * stays an unbroken run of the original series, so the autocorrelation/
 * block structure inside it survives untouched -- only which slabs are kept
 * is randomized, not the order of what is inside them. Stratifying across
 * the whole range (rather than one single contiguous slice of length
 * maxLen) keeps every part of a multi-symbol pooled series represented,
 * instead of a slice that could land entirely inside one symbol's data.
 * Deterministic for a given (len, maxLen, seed).
 */
function pickSubsampleIndices(len: number, maxLen: number, seed: number): number[] {
  if (len <= maxLen) {
    const all = new Array<number>(len);
    for (let i = 0; i < len; i++) all[i] = i;
    return all;
  }

  const rng = mulberry32(seed);
  const blockCount = Math.min(SUBSAMPLE_BLOCK_COUNT, len);
  const strataSize = Math.floor(len / blockCount);
  const blockLen = Math.max(1, Math.floor(maxLen / blockCount));

  const indices: number[] = [];
  for (let b = 0; b < blockCount; b++) {
    const strataStart = b * strataSize;
    const strataEnd = b === blockCount - 1 ? len : strataStart + strataSize;
    const available = Math.max(1, strataEnd - strataStart - blockLen);
    const offset = strataStart + Math.floor(rng() * available);
    const end = Math.min(strataEnd, offset + blockLen);
    for (let i = offset; i < end; i++) indices.push(i);
  }
  return indices;
}

/**
 * Reduces (factor, fwd) to at most maxPairs positionally-aligned rows before
 * they reach standardizedRankProducts/bootstrapCiOfMean, when the pooled
 * series is larger than that. A pooled 5m/10-symbol series is on the order
 * of 1M rows; ranking is O(m log m) even done once, and each bootstrap
 * iteration is still O(m), so bounding the input size bounds both the
 * one-time ranking cost and the per-iteration cost regardless of how large
 * the underlying dataset is. Below maxPairs, both arrays are returned
 * unchanged.
 */
function subsampleForBootstrap(
  factor: number[],
  fwd: (number | null)[],
  maxPairs: number,
  seed: number
): { factor: number[]; fwd: (number | null)[] } {
  const len = Math.min(factor.length, fwd.length);
  if (len <= maxPairs) return { factor, fwd };

  const indices = pickSubsampleIndices(len, maxPairs, seed);
  return {
    factor: indices.map((i) => factor[i]),
    fwd: indices.map((i) => fwd[i]),
  };
}

/**
 * Concatenates Float64Arrays into one. Not `[].concat(...)`: TypedArrays are
 * not concat-spreadable (per the ES spec), so `[].concat(float64arr)` pushes
 * the whole array as a single nested element instead of spreading its
 * numbers -- a real correctness bug, not just a style choice.
 */
function concatFloat64(chunks: Float64Array[]): Float64Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float64Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Builds one HorizonStat, or null when there is not enough usable data at
 * this horizon (fewer than MIN_PAIRS valid pairs, overlapping or
 * non-overlapping) to produce a well-defined statistic. This is the gate
 * that keeps every published field a real, finite number: a factor with no
 * data at all for this interval (e.g. a funding-rate-derived factor on 5m/
 * 15m, which never has snapshot data) simply produces no HorizonStat here,
 * rather than one full of NaN.
 *
 * `fwdTyped` is a Float64Array (NaN as the missing sentinel), not the
 * `(number | null)[]` ic-stats.ts's functions take: it is converted to a
 * plain array once here and reused for every statistic this cell computes,
 * so the caller's long-lived forward-return cache (see fwdFor) can stay in
 * the compact, unboxed Float64Array representation instead of the ~3-4x
 * larger boxed-element array `(number | null)[]` forces in V8 once `null`
 * appears in it.
 */
function buildHorizonStat(
  factorArr: number[],
  fwdTyped: Float64Array,
  horizon: number,
  bootstrap: { iterations: number; seed: number; maxPairs: number; gateAbsT: number | null } | null
): HorizonStat | null {
  const fwd: (number | null)[] = Array.from(fwdTyped);
  const overlap = icWithHac(factorArr, fwd, horizon);
  if (overlap.n < MIN_PAIRS || !Number.isFinite(overlap.ic) || !Number.isFinite(overlap.t)) {
    return null;
  }

  const nonOverlap = icNonOverlapping(factorArr, fwd, horizon);
  if (nonOverlap.n < MIN_PAIRS || !Number.isFinite(nonOverlap.ic)) {
    return null;
  }

  const idxs = nonOverlappingIndices(Math.min(factorArr.length, fwd.length), horizon, 0);
  const factorSub = idxs.map((i) => factorArr[i]);
  const fwdSub = idxs.map((i) => fwd[i] ?? NaN);

  const hitRate = signHitRate(factorSub, fwdSub);
  const spread = quantileSpread(factorSub, fwdSub);
  if (
    !Number.isFinite(hitRate) ||
    !Number.isFinite(spread.top) ||
    !Number.isFinite(spread.bottom) ||
    !Number.isFinite(spread.spread)
  ) {
    return null;
  }

  let bootstrapCi95: [number, number] | null = null;
  if (bootstrap && (bootstrap.gateAbsT === null || Math.abs(overlap.t) >= bootstrap.gateAbsT)) {
    const sample = subsampleForBootstrap(factorArr, fwd, bootstrap.maxPairs, bootstrap.seed);
    // Fixed-rank block bootstrap (see this file's header comment): ranks are
    // computed once by standardizedRankProducts, not re-ranked per resample,
    // so bootstrapCiOfMean only resamples and averages -- O(n) per
    // iteration, no sorting.
    const d = standardizedRankProducts(sample.factor, sample.fwd);
    const ci = bootstrapCiOfMean(d, {
      iterations: bootstrap.iterations,
      meanBlockLen: horizon,
      seed: bootstrap.seed,
    });
    if (Number.isFinite(ci.low) && Number.isFinite(ci.high)) {
      bootstrapCi95 = [ci.low, ci.high];
    }
  }

  return {
    horizon,
    n: overlap.n,
    ic: overlap.ic,
    icT: overlap.t,
    nNonOverlapping: nonOverlap.n,
    icNonOverlapping: nonOverlap.ic,
    signHitRate: hitRate,
    bootstrapCi95,
    quantileSpread: spread,
  };
}

function buildRollingQuarterly(
  timestamps: number[],
  factorArr: number[],
  fwdTyped: Float64Array,
  horizon: number
): FactorReport['rollingQuarterly'] {
  const fwd: (number | null)[] = Array.from(fwdTyped);
  return rollingByQuarter(timestamps, factorArr, fwd, horizon)
    .filter((r) => r.n >= MIN_PAIRS && Number.isFinite(r.ic) && Number.isFinite(r.t))
    .map((r) => ({ quarter: r.quarter, horizon, ic: r.ic, n: r.n, t: r.t }));
}

function resolveCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Full, file-free computation pipeline: verifies the dataset, loads every
 * requested symbol, computes every requested factor's per-symbol and pooled
 * statistics plus rolling-quarterly IC, and returns a schema-validated
 * report. Throws on a manifest mismatch, an unknown requested factor, or a
 * report that fails validation.
 */
export async function buildFactorIcReport(args: FactorIcArgs): Promise<FactorIcReport> {
  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) {
    throw new Error(`Dataset manifest verification failed for: ${verify.mismatches.join(', ')}`);
  }
  const manifest = loadManifest(args.datasetDir);
  if (args.expectManifestHash !== undefined && manifest.datasetHash !== args.expectManifestHash) {
    throw new Error(
      `Dataset manifest hash mismatch: loaded dataset has ${manifest.datasetHash}, expected ${args.expectManifestHash}`
    );
  }
  const symbols = args.symbols && args.symbols.length > 0 ? args.symbols : manifest.symbols;

  console.error(`[factor-ic] interval=${args.interval} symbols=${symbols.join(',')} horizons=${args.horizons.join(',')}`);

  const perSymbolData: SymbolData[] = [];
  for (const symbol of symbols) {
    console.error(`[factor-ic] loading ${symbol}...`);
    perSymbolData.push(
      loadSymbolData(args.datasetDir, symbol, args.interval, {
        allowLockbox: args.allowLockbox,
        start: args.start,
        end: args.end,
      })
    );
  }
  const lockboxApplied = perSymbolData.every((s) => s.lockboxApplied);

  // Union of factor names across symbols' matrices, first-seen order (they
  // agree on raw.*/cat.*/composite; sig.* can differ when a signal never
  // fires for a given symbol's data).
  const nameOrder: string[] = [];
  const nameCategory = new Map<string, string>();
  for (const data of perSymbolData) {
    data.matrix.names.forEach((name, i) => {
      if (!nameCategory.has(name)) {
        nameCategory.set(name, data.matrix.categories[i]);
        nameOrder.push(name);
      }
    });
  }

  let requestedFactors = nameOrder;
  if (args.factors) {
    const missing = args.factors.filter((f) => !nameCategory.has(f));
    if (missing.length > 0) {
      throw new Error(`Unknown factor(s) requested: ${missing.join(', ')}`);
    }
    requestedFactors = args.factors;
  }

  // Per-symbol bootstrapCi95 (opt-in via --bootstrap-per-symbol) is ungated:
  // gateAbsT: null means "always attempt", since it is already off by
  // default and the caller explicitly asked for it.
  const bootstrapPerSymbolOpt = args.bootstrapPerSymbol
    ? { iterations: args.bootstrapN, seed: args.bootstrapSeed, maxPairs: args.bootstrapMaxPairs, gateAbsT: null }
    : null;
  // Pooled bootstrapCi95 is attempted for every requested factor x horizon,
  // but only actually computed for cells whose pooled HAC |icT| clears
  // BOOTSTRAP_GATE_ABS_T (a ruling from the controller after C3's initial
  // report flagged that "always computed" at the default --bootstrap-n
  // (formerly 1000), re-ranking every resample, was on the order of 15
  // minutes per pooled cell at full production scale; a second ruling then
  // replaced the re-ranking bootstrap with the fixed-rank one this file's
  // header describes, at roughly 21 seconds per gated cell before the
  // fixed-rank change and well under a second after it -- see the C3
  // report's two fix-round entries for both benchmarks). Cells below the
  // gate carry bootstrapCi95: null.
  const bootstrapPooledOpt = {
    iterations: args.bootstrapN,
    seed: args.bootstrapSeed,
    maxPairs: args.bootstrapMaxPairs,
    gateAbsT: BOOTSTRAP_GATE_ABS_T,
  };

  // forwardReturns depends only on (symbol, horizon), not on the factor, so
  // it is computed once per pair and reused across every requested factor.
  // Cached as Float64Array (NaN sentinel), not the (number | null)[]
  // forwardReturns itself returns: at 10 symbols x 105,000 5m bars x 6
  // horizons, a (number | null)[] cache costs on the order of 1 GB in V8
  // (null in the array forces boxed/tagged elements, roughly 24-32 bytes
  // each, instead of the 8 bytes/element a homogeneous-double Float64Array
  // uses). See the C3 report's fix-round entry for the measured heap.
  const fwdCache = new Map<string, Float64Array>();
  function fwdFor(symbolIdx: number, horizon: number): Float64Array {
    const key = `${symbolIdx}:${horizon}`;
    let cached = fwdCache.get(key);
    if (!cached) {
      const raw = forwardReturns(perSymbolData[symbolIdx].matrix.closes, horizon, args.executionLagBars);
      cached = Float64Array.from(raw, (v) => v ?? NaN);
      fwdCache.set(key, cached);
    }
    return cached;
  }

  const factorReports: FactorReport[] = [];
  const skippedFactors: FactorIcReport['skippedFactors'] = [];

  for (const factorName of requestedFactors) {
    console.error(`[factor-ic] computing ${factorName}...`);

    const perSymbol: FactorReport['perSymbol'] = [];
    // Per-symbol arrays retained for pooling below (null when this symbol's
    // matrix never discovered this factor at all, e.g. a sig.* that never fired).
    const symbolFactorArrays: Array<number[] | null> = [];

    for (let s = 0; s < perSymbolData.length; s++) {
      const { matrix } = perSymbolData[s];
      const idx = matrix.names.indexOf(factorName);
      if (idx === -1) {
        symbolFactorArrays.push(null);
        continue;
      }
      // Float64Array must not be passed directly into ic-stats.ts's functions:
      // they call .map/.reduce expecting a plain number[] result, which
      // Float64Array.prototype.map does not produce.
      const factorArr = Array.from(matrix.values[idx]);
      symbolFactorArrays.push(factorArr);

      const horizonsForSymbol: HorizonStat[] = [];
      for (const h of args.horizons) {
        const stat = buildHorizonStat(factorArr, fwdFor(s, h), h, bootstrapPerSymbolOpt);
        if (stat) horizonsForSymbol.push(stat);
      }
      if (horizonsForSymbol.length > 0) {
        perSymbol.push({ symbol: perSymbolData[s].symbol, horizons: horizonsForSymbol });
      }
    }

    // Pooled: concatenate every symbol's factor and forward-return series in
    // symbol order. Uses .concat, not push(...array)/Math.min(...array): a
    // spread that large would risk exceeding the engine's call-argument limit.
    let pooledFactor: number[] = [];
    let pooledTimestamps: number[] = [];
    for (let s = 0; s < perSymbolData.length; s++) {
      const arr = symbolFactorArrays[s];
      if (arr) {
        pooledFactor = pooledFactor.concat(arr);
        pooledTimestamps = pooledTimestamps.concat(perSymbolData[s].matrix.timestamps);
      }
    }

    const pooledHorizons: HorizonStat[] = [];
    const rollingQuarterly: FactorReport['rollingQuarterly'] = [];

    for (const h of args.horizons) {
      const pooledFwdChunks: Float64Array[] = [];
      for (let s = 0; s < perSymbolData.length; s++) {
        if (symbolFactorArrays[s]) {
          pooledFwdChunks.push(fwdFor(s, h));
        }
      }
      const pooledFwd = concatFloat64(pooledFwdChunks);

      const stat = buildHorizonStat(pooledFactor, pooledFwd, h, bootstrapPooledOpt);
      if (stat) pooledHorizons.push(stat);

      rollingQuarterly.push(...buildRollingQuarterly(pooledTimestamps, pooledFactor, pooledFwd, h));
    }

    if (pooledHorizons.length === 0) {
      // No usable signal anywhere for this factor at this interval (e.g. a
      // funding/sentiment-derived factor on 5m/15m, which never has snapshot
      // data). Recorded in skippedFactors rather than encoded as NaN in a
      // report whose numeric fields are all plain, schema-validated numbers,
      // so it is visible to the orchestrator instead of silently vanishing.
      const reason = 'no finite pairs at any horizon';
      console.error(`[factor-ic] skipping ${factorName}: ${reason}`);
      skippedFactors.push({ name: factorName, category: nameCategory.get(factorName) ?? 'unknown', reason });
      continue;
    }

    factorReports.push({
      name: factorName,
      category: nameCategory.get(factorName) ?? 'unknown',
      perSymbol,
      pooled: { horizons: pooledHorizons },
      rollingQuarterly,
    });
  }

  let startMs = Infinity;
  let endMs = -Infinity;
  for (const data of perSymbolData) {
    for (const t of data.matrix.timestamps) {
      if (t < startMs) startMs = t;
      if (t > endMs) endMs = t;
    }
  }
  const dateRange = {
    startMs: Number.isFinite(startMs) ? startMs : 0,
    endMs: Number.isFinite(endMs) ? endMs : 0,
  };

  const report: FactorIcReport = {
    schemaVersion: 1,
    taskId: args.taskId,
    datasetManifestHash: manifest.datasetHash,
    lockboxApplied,
    interval: args.interval,
    symbols,
    horizons: args.horizons,
    executionLagBars: args.executionLagBars,
    dateRange,
    computedAt: new Date().toISOString(),
    gitCommit: resolveCommit(),
    bootstrap: {
      iterations: args.bootstrapN,
      seed: args.bootstrapSeed,
      perSymbol: args.bootstrapPerSymbol,
      gateAbsT: BOOTSTRAP_GATE_ABS_T,
      maxPairs: args.bootstrapMaxPairs,
    },
    factors: factorReports,
    skippedFactors,
  };

  const validated = validateFactorIcReport(report);
  if (!validated.ok) {
    throw new Error(`factor-ic report failed schema validation:\n${validated.issues.join('\n')}`);
  }

  return validated.data;
}

/**
 * The 15 largest pooled |icT| rows across all horizons (not top 15 per
 * horizon): every factor's pooled HorizonStat, at every horizon, is flattened
 * into one list and sorted by |icT|, so a factor can appear more than once
 * if several of its horizons rank highly, and a horizon with no standout
 * factor may not appear at all.
 */
function formatTopTable(report: FactorIcReport): string {
  const rows: Array<{ factor: string; horizon: number; ic: number; icT: number; n: number }> = [];
  for (const factor of report.factors) {
    for (const h of factor.pooled.horizons) {
      rows.push({ factor: factor.name, horizon: h.horizon, ic: h.ic, icT: h.icT, n: h.n });
    }
  }
  rows.sort((a, b) => Math.abs(b.icT) - Math.abs(a.icT));
  const top = rows.slice(0, 15);

  const title = 'top 15 pooled |icT| rows across all horizons:';
  const header = ['factor', 'horizon', 'ic', 'icT', 'n'].map((h) => h.padEnd(10)).join('');
  const lines = top.map((r) =>
    [
      r.factor.padEnd(28),
      String(r.horizon).padEnd(10),
      r.ic.toFixed(4).padEnd(10),
      r.icT.toFixed(2).padEnd(10),
      String(r.n),
    ].join('')
  );
  return [title, header, ...lines].join('\n');
}

/** Computes and writes the full report, then prints a top-factors table and survivor count. */
export async function runFactorIc(args: FactorIcArgs): Promise<FactorIcReport> {
  const report = await buildFactorIcReport(args);

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.error(`[factor-ic] wrote ${args.out}`);

  console.log(formatTopTable(report));
  const survivors = evaluateSurvivors(report).filter((row) => row.survivor).length;
  console.log(`survivors: ${survivors} / ${report.factors.length} factors`);
  console.log(`skipped: ${report.skippedFactors.length} factor(s) with no usable data`);

  return report;
}

/**
 * Recomputes one (factor, horizon[, symbol]) cell -- pooled across
 * --symbols/the manifest's symbols when no symbol is given -- and prints it
 * as JSON to stdout. Writes no file; used by the orchestrator to spot-check
 * a subagent's report (see report-schema.ts's spotCheckCell).
 *
 * When args.reportPath is set (--cell --report <path>), the referenced
 * FactorIcReport's symbols, dateRange (as start/end), and lockboxApplied
 * (as !allowLockbox) are used instead of args.symbols/start/end/
 * allowLockbox, which are ignored in that mode -- so the orchestrator's spot
 * check reproduces exactly the window the subagent's report was built from,
 * not whatever the CLI invocation's own flags happened to say. The current
 * dataset's manifest hash is also checked against the report's
 * datasetManifestHash (in addition to any --expect-manifest-hash), since a
 * spot check against a different dataset than the report used would not be
 * reproducing anything.
 */
export async function runCell(args: FactorIcArgs): Promise<CellResult> {
  if (!args.cell) {
    throw new Error('runCell requires args.cell');
  }

  let symbolsOverride = args.symbols;
  let startOverride = args.start;
  let endOverride = args.end;
  let allowLockboxOverride = args.allowLockbox;
  let expectManifestHash = args.expectManifestHash;
  let executionLagOverride = args.executionLagBars;

  if (args.reportPath) {
    const raw = JSON.parse(await readFile(args.reportPath, 'utf8'));
    const validated = validateFactorIcReport(raw);
    if (!validated.ok) {
      throw new Error(`--report ${args.reportPath} failed schema validation:\n${validated.issues.join('\n')}`);
    }
    const report = validated.data;
    symbolsOverride = report.symbols;
    startOverride = report.dateRange.startMs;
    endOverride = report.dateRange.endMs;
    allowLockboxOverride = !report.lockboxApplied;
    // Absent on reports written before the option existed, which all used 0.
    executionLagOverride = report.executionLagBars ?? 0;
    expectManifestHash = expectManifestHash ?? report.datasetManifestHash;
  }

  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) {
    throw new Error(`Dataset manifest verification failed for: ${verify.mismatches.join(', ')}`);
  }
  const manifest = loadManifest(args.datasetDir);
  if (expectManifestHash !== undefined && manifest.datasetHash !== expectManifestHash) {
    throw new Error(
      `Dataset manifest hash mismatch: loaded dataset has ${manifest.datasetHash}, expected ${expectManifestHash}`
    );
  }

  const { factor: factorName, horizon, symbol } = args.cell;

  let ic: number;
  let n: number;

  if (symbol) {
    const data = loadSymbolData(args.datasetDir, symbol, args.interval, {
      allowLockbox: allowLockboxOverride,
      start: startOverride,
      end: endOverride,
    });
    const idx = data.matrix.names.indexOf(factorName);
    if (idx === -1) {
      throw new Error(`Factor "${factorName}" not present for symbol ${symbol}`);
    }
    const factorArr = Array.from(data.matrix.values[idx]);
    const result = icWithHac(
      factorArr,
      forwardReturns(data.matrix.closes, horizon, executionLagOverride),
      horizon
    );
    ic = result.ic;
    n = result.n;
  } else {
    const symbols = symbolsOverride && symbolsOverride.length > 0 ? symbolsOverride : manifest.symbols;

    let pooledFactor: number[] = [];
    let pooledFwd: (number | null)[] = [];
    let foundAny = false;
    for (const sym of symbols) {
      const data = loadSymbolData(args.datasetDir, sym, args.interval, {
        allowLockbox: allowLockboxOverride,
        start: startOverride,
        end: endOverride,
      });
      const idx = data.matrix.names.indexOf(factorName);
      if (idx === -1) continue;
      foundAny = true;
      pooledFactor = pooledFactor.concat(Array.from(data.matrix.values[idx]));
      pooledFwd = pooledFwd.concat(
        forwardReturns(data.matrix.closes, horizon, executionLagOverride)
      );
    }
    if (!foundAny) {
      throw new Error(`Factor "${factorName}" not present for any of: ${symbols.join(', ')}`);
    }
    const result = icWithHac(pooledFactor, pooledFwd, horizon);
    ic = result.ic;
    n = result.n;
  }

  const cellResult: CellResult = { factor: factorName, horizon, ic, n, ...(symbol ? { symbol } : {}) };
  console.log(JSON.stringify(cellResult));
  return cellResult;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cell) {
    await runCell(args);
  } else {
    await runFactorIc(args);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
