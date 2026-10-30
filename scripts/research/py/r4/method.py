"""ROUND 4 METHOD LOCK (M), LOCK TEXT V3. Plan of record: ~/.claude/plans/squishy-zooming-wilkes.md (owner-approved
2026-10-25). Gate M reviewed version 1 and version 2 (Opus, 2026-10-25, both PASS WITH FIXES). Neither was signed.
V3.1 (before signing): the gate M v3 check's fixes (the basket rule, the spans, the trial unit) and its disclosures.
SIGNED by the owner on 2026-10-25 (session 41) for the text at 455ac2a0, after the Opus gate returned SIGN.
This version adopts both reviews' fixes (.superpowers/sdd/round4/gates/). It is committed before any Round 4 model
reads development outcomes, and the owner signs it. Changes after the first development read are AMENDMENTS appended
below, never edits.

WHAT WAS READ BEFORE THIS LOCK (disclosed)
- Development D (perp 2022-01-01 to 2026-06-30) was read by earlier studies (Phases 3 to 5, Rounds 1 to 3).
- The Phase 1 audit read code and production counts only (.superpowers/sdd/round4/audit.md).
- The overlap simulation and the pipeline's statistical tests used synthetic data only.
- Holdout H was ingested on 2026-10-25 (counts only). No study has computed anything on it, and the Round 4 export
  (~/round4-ds, datasetHash 11c87b9c8a97...) holds D only.

PARTITIONS AND DATA EDGES
- DEV_START 2022-01-01, DEV_END 2026-07-01 (exclusive): perp 5m, 15m, 1h, 4h and 1d bars, premium index and funding
  settlements of the 10 signal coins.
- Tier B inputs (futures metrics, depth, aggTrades flow, options) develop from 2023-01-01 only. A Tier B row stamped
  t is usable at T only if t + 5 minutes <= T.
- Recent R: 2026-07-01 to the date of this lock, descriptive only, never used to select.
- Holdout H 2020-01-01 to 2022-01-01 (exclusive), perp 5m to 4h from each coin's first archive bar. Perp 1d bars and
  funding before 2022 were read by the broad studies and are disclosed as read inputs.
- Universe: the 10 signal coins (BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK), every family included. Their
  2026 selection is the program's known survivorship limit, stated in every result.
- Edges:
  - a D sample whose label ends at or after DEV_END is dropped, and so is an H sample whose label ends at or after
    H_END;
  - a D sample whose features would need intraday bars before DEV_START has missing features and is dropped (the
    loader serves no intraday row before 2022 for D);
  - a sample with ANY missing feature is dropped, never imputed, and no missing value reaches a model;
  - a tranche whose window lacks a funding settlement the coin's interval in force says must exist is dropped and
    counted (funding is never assumed);
  - the EMA warm-ups make the first months of D and of each H coin sparse, which is disclosed.

TIMING, COSTS AND THE BOOK RULE
- Decision at the close T of a perp 1h or 4h bar. Inputs: bars closed at T only (t + interval <= T), settlements
  with t <= T.
- Entry at the open of the 5m bar starting at T + 10 minutes. Exit at the open of the 5m bar starting at
  T + 10 minutes + h. Horizons: h in {4h, 8h} at 1h, and h in {4h, 8h, 24h} at 4h.
- Costs: Binance USDT-M VIP 0 (maker 0.02%, taker 0.05%), with study slippage on taker fills (3 bps at 1h, 2 bps at
  4h), charged as abs(weight) x rate on the fill day. Funding is the sum of actual settlements in (entry, exit] times
  -weight, and a positive rate means longs pay.
- r4.costs reproduces the fee, slippage and funding functions of src/lib/backtest/cost-model.ts and funding.ts to
  1e-8. Labels use the Round 4 additive convention, which agrees with the TypeScript multiplicative slippage to first
  order.
- BOOK RULE: the equity is split into 10 equal coin slots. Each decision on a coin opens one tranche of weight
  w = side x size x (interval / h) x 1/10, with h the configured horizon even if a declared exit closes the tranche
  earlier, so overlapping tranches stack to at most one slot.
  - size is 1 unless the family's declared rule sets it in [0, 1].
  - Family D replaces the slot rule: each decision sets dollar-neutral target weights w_i with sum of abs(w_i) = 1,
    and each tranche carries w_i x interval / h.
  - Each UTC day, a tranche's part inside the day is marked in log return at the 00:00 5m open (carried from the last
    5m open before midnight if that bar is missing, and counted).
  - Settlements in (day start, day end] go to that day.
- Triple-barrier labels: barriers at entry x exp(+-1.0 x sigma_h), with sigma_h = sqrt(the sum of squared 5m log
  returns over the 24 hours to T, times h / 24 hours). A missing 5m bar in that window makes sigma_h missing and drops
  the sample.
  - The scan covers the 5m bars from the entry bar (included) to the horizon.
  - A take-profit needs a strict trade-through and fills as maker at the barrier.
  - A stop fills as taker at the worse of the barrier and the touching bar's open.
  - A bar trading through both books the stop.

THE DRIFT-FREE DAILY SERIES (used by every gate)
- For each UTC day d, the drift-free daily return of a configuration is the beta-hedged book return
    D_d = sum over tranches open in day d of w x (r_coin - beta_coin x r_EW) - costs_d + funding_d,
  where:
  - r_coin is the log return of the tranche's part inside the day;
  - r_EW is the mean log return over the SAME interval of those of the 10 coins with a price at both ends of the
    interval. The basket size is recorded and its changes are disclosed (in H, DOGE, DOT, SOL and AVAX list during
    2020; anywhere, a coin missing a bar at an interval boundary leaves the basket for that interval);
  - beta_coin is the OLS slope of the coin's daily log return on the basket's daily mean (same basket rule).
- beta_coin is estimated on the training window of each walk-forward fold, on the split's training set in CPCV, on the
  training window in force at the date a shifted tranche lands in the joint-shift null, and on all of D for H and
  lab-v5, where it is fixed in the finalist lock.
- A no-bet day (no open tranche) is a zero in this series for every statistic below, except c and the lab-v5 power,
  which use bet days only.
- Spans: items 1, 3, 5 and 6 use each configuration's own walk-forward span (its first refit to DEV_END). The SPA and
  PBO matrices of a family use the intersection of its configurations' spans (from the latest first refit among them).
- D_d removes beta drift but keeps coin-specific drift. The joint-shift null, which keeps the same coins, controls
  coin-specific drift and is the binding test for it.
- The raw (unhedged) book return is reported beside every result and is never gated.

TRAINING, CUTOFFS AND VALIDATION
- Walk-forward (the deployable path): refit at the first instant of each UTC month from 2023-01-01 (from 2024-01-01
  for Tier B and for family B, so all its primaries share one span) to DEV_END.
  - Each month is a test block.
  - Training holds samples with t1_max < refit within the lookback arm: 12 months, 24 months or all of D (12 months
    and all for Tier B).
  - Preprocessing and any family C filter are fitted on each training window only.
  - LightGBM uses a fixed number of trees per declared setting, with no early stopping.
- The no-refit arm is fit once on all data before the first refit and never refit, as a single configuration.
- CPCV on the pooled, time-sorted panel: 6 groups by time (ties share a group), 2 test groups, purging any training
  sample whose [t0, t1_max] overlaps a test block on any coin, and an embargo of 30 days after each block.
  - Lookback arms apply to the walk-forward only.
  - CPCV is a necessary hurdle and is never used for ranking, c, H power or finalist evidence.
  - Features with lookbacks over 30 days (trend_1d, atr14_1d, dist_pdh, dist_pdl, dist_poc, trend_4h, funding_z30d)
    can carry test-period prices into post-test training rows. Leakage biases CPCV upward, so it can only make the
    hurdle easier, which is disclosed. Each finalist also gets a descriptive CPCV with a 200-day embargo.
- Refit question: the monthly refit is adopted for the live model only if the paired block-bootstrap 90% interval
  (mean block 10 days, 1,000 reps) of the drift-free daily mean difference (refit minus no-refit) lies entirely above
  zero.
- Final model of a finalist: fit with its lookback arm on the window ending at the cutoff, DEV_END minus 30 days.

TRIALS, BUDGET AND LEDGER
- One trial per distinct configuration whose D outcome is computed in any way (walk-forward, CPCV or a probe), plus
  one per re-run after a code fix, and the count never goes down. The exploration bar's own nulls, the label-shift
  tripwire and the descriptive 200-day CPCV add no trials. A configuration is fully specified by:
  - family, model, hyperparameter setting, feature set;
  - interval, horizon, label type, decision threshold, side rule, size rule;
  - family C filter (on or off);
  - lookback or refit arm, exit rule.
- Caps: A 48, B 24, D 12, E 24, re-tests 12 (120 alpha-bearing). C (forecasts) is capped at 12 and counted
  separately. Re-runs consume the cap, and a family that reaches its cap stops.
- Each family appends one entry to scripts/research/ledger.ts in the commit that declares its configurations, before
  it runs, and appends re-runs as they happen. The program count before Round 4 is 2,204. Controls (Phase 4) are
  recorded in the ledger and are excluded from the trial-Sharpe variance.

EXPLORATION BAR (a configuration becomes a finalist only if all hold; every expectancy is on the drift-free series)
1. Walk-forward drift-free daily mean above zero, and at least 4 of the 5 CPCV paths with a positive drift-free mean.
2. PBO at most 0.25 (CSCV, 16 groups, on the family's drift-free daily matrix over its common span).
3. Deflated Sharpe probability at least 0.95 on the drift-free daily series (n = calendar days of the span, no-bet
   days zero), with N = max(120, the round's alpha-bearing ledger count at round close) for every configuration. The
   variance of trial Sharpes is taken over the round's alpha-bearing configurations at round close, identical
   configurations counted once. Round close is the commit of the last family's results. Also reported at the program
   count (2,204 + N).
4. Run only for configurations passing items 1 to 3:
   - Joint-shift random-entry null: 1,000 circular shifts of the whole tranche set by whole days (at least 7), all
     coins together with the same sizes, sides and holds. The statistic is the drift-free return per unit of absolute
     weight over the kept tranches. A shifted tranche that wraps past the span or lands on missing data is dropped,
     and the drop share is reported. p = (1 + count(null >= observed)) / (1 + 1000), below 0.05.
   - Hansen SPA on the family's drift-free daily matrix over its common span, against zero, using Hansen's consistent
     p-value (SPA_c), stationary bootstrap with mean block 10 days, 1,000 reps. p below 0.05. It corrects for
     selection within a family. The deflated Sharpe at N covers selection across families.
   - Label-shift tripwire: 100 panel-wide circular shifts of labels against features by at least 30 days. If more
     than 60 of 100 give a positive drift-free mean, the family halts for a leakage review.
5. At least 7 of 10 coins with a positive drift-free daily mean (each coin's tranches alone), or for family D a
   drop-one-coin jackknife that stays positive.
6. Fees x1.5 and slippage x2, and separately every maker fill repriced as taker, each keep the drift-free daily mean
   at or above zero.
- Finalists are ranked by the drift-free daily Sharpe. At most one finalist per (family, model), and at most 3
  directional finalists in all.
- Family C (forecasts, no trading):
  - QLIKE and log-variance MSE better than persistence and EWMA (halflife 7 windows) with a Diebold-Mariano p below
    0.05 (HAC with lag h) on the walk-forward path;
  - 80% and 95% coverage of the horizon log return within 2 points of nominal;
  - on at least 8 of 10 coins.
  At most 1 forecast finalist, the configuration with the best walk-forward QLIKE.
- Stay-out flag (part of the family C finalist), two conditions:
  - forecast volatility above its trailing 90-day 90th percentile passes if the block-bootstrap (mean block 10 days)
    95% interval of the realised-volatility ratio of flagged over unflagged windows lies entirely above 1;
  - a forecast range over the hold below 3 times the round-trip cost passes if at least 60% of flagged windows have a
    realised high-low range below 3 times the cost.

PIPELINE CALIBRATION (Phase 4, before any family runs; each prediction is committed before its run)
- Positive control: a planted edge injected into D returns, at an effect the power simulation says is detected with
  probability at least 0.8. The pipeline must detect it.
- Noise control: 40 random-feature configurations. At most 5 may pass items 1 to 3, and at most 6 may reject the
  joint-shift null at 0.05.
- Re-tests of closed rules as labelled re-reads (re-tests budget): v8 at 1h and 4h, rv-v1, Round 1 C1, lab-v4 S1 and
  S2, and N2, N3 and F1 where their shape fits. They are negative controls. One that passes means the pipeline is
  presumed defective until an independent re-implementation agrees.
- lab-v5 grading null: the beta-hedged daily e-process under a correlated no-edge null (correlation as measured in D),
  with its false-crossing rate against 1/600 reported before any lab-v5 code exists.
- Gate P: an Opus review accepts the pipeline only if every control behaves as predicted.

HOLDOUT H
- All finalist locks (directional and forecast) are committed and signed before the first H read, and the reads run in
  one batch.
- Before each read, Claude verifies three things: the read id equals the 40-character sha of a commit that adds that
  finalist's lock; the commit is an ancestor of research/round4; the working tree is clean.
- The r4.data ledger at the fixed path ~/round4-out/holdout-reads.jsonl records (read_id, finalist_id, path). It
  refuses a fifth read id, a second read id for the same finalist, and a repeated (read_id, path). The cache never
  holds H rows. A read is recorded when its rows are returned: a run that fails before that may be repeated, and one
  that fails after it counts as read. The git checks are done by Claude outside the container (the research image has
  no git); r4.data enforces the id format and the ledger rules.
- Each finalist lock states three things before any read:
  - the frozen procedure, the model artifact hash and beta_coin from D;
  - the power: a block-bootstrap of the finalist's D drift-free daily series, with its deviations about the mean
    rescaled by the H-to-D ratio of 1d realised volatility, resampled to the length of H's span and shifted to half
    its mean, for the H criterion "drift-free mean above zero";
  - the pass criteria below.
- Directional H pass, applied once with the final model and no refit inside H:
  - drift-free daily mean above zero, on all coins with data and separately on the six coins listed by February 2020
    (BTC, ETH, XRP, LINK, ADA, BNB);
  - at least 60% of the coins with data positive. A coin has data if it has at least 30 graded tranches after its
    first 60 days of listing;
  - fees x1.5 and slippage x2 keep the drift-free mean at or above zero;
  - the joint-shift null with p below 0.05/3.
- Forecast H pass: the family C criteria on H for the forecast finalist and its stay-out flag, at p below 0.05 (its own
  read id).
- If the stated power is below 0.5, a fail is recorded as inconclusive. An inconclusive finalist is not promoted, is
  never read again, and gets no lab-v5. An H pass still counts at any power.
- A Tier B finalist skips H, runs forward only and is never shown as provisional.

LAB-V5 (FORWARD)
- A directional finalist gets a lab-v5 slot only after an H pass (Tier B excepted, forward only).
- Statistic: the drift-free daily series D_d of the finalist with beta_coin from D, x = min(D_d / c, 1), placing no bet
  on a no-bet day. Unbounded losses: a day with x below -2 is counted at -2 and ends the test (loss floor -2, H0'),
  recorded as "ended, not validated". The raw book return e-process is kept as a descriptive record.
- Threshold 600 per slot: e-Bonferroni arithmetic, 3 slots at alpha 0.005. Warm-up 30 bets.
- c = 4 times the SD of the finalist's D walk-forward drift-free daily series over bet days, fixed in the finalist
  lock before H, never taken from H or R.
- Missing data:
  - a missing price waits, never dropped, and is carried to the next priced bar for marking;
  - a missing funding settlement waits at most 72 hours, then the day is graded with the settlements found and the gap
    is recorded. Development drops such a tranche instead; the asymmetry is deliberate (a forward record cannot wait
    forever) and disclosed.
- Validity: the days are disjoint and the bets are sized from earlier days only, so the e-process is a supermartingale
  under the null of no edge given the information at each entry. The overlap simulation is a consistency check: at
  k = 600, daily mark-to-market grading had 0 crossings (continuation) and 1 (fade) in 50,000 no-edge paths each,
  against 119 (0.238%, above 1/600) for lab-v4's per-trade grading.
- The lab-v5 lock states honest power and a 24-month limit.
- Promotion: an H pass puts the finalist on the paper desk and Focus as "provisional". "Validated" only when its lab-v5
  e-process crosses. The family C forecast reaches Focus after its own H pass.

PREDICTIONS (recorded before any development read)
- Given 2,204 earlier trials with no pass, the most likely outcome is that no directional configuration meets the
  exploration bar.
- Family C (volatility) is the likeliest to pass its forecast bar, because volatility clustering is the one effect the
  program has replicated.
- If a directional configuration passes, it is most likely at 1h with BTC-relative or intrabar flow inputs. We predict
  it does not pass H.

STOP RULE
- If no configuration meets the exploration bar within the budget, Round 4 closes with no lab-v5, and the RESULT block
  says so.
- An override must be recorded as an amendment that quotes the result it overrides, as lab-v4 was.

AMENDMENT 1 (2026-10-28, owner-approved in session 43; SIGNED by the owner on 2026-10-29 (session 44) for the text
at 3c68c376). It is written before any Round 4 configuration has computed a development outcome. It changes how the
bar is measured and executed, and changes no threshold, span, budget or H rule.

A1.1 COSTS, to match Binance USDT-M one-way execution. It amends "Costs: ... charged as abs(weight) x rate on the fill
day" and "with study slippage on taker fills (3 bps at 1h, 2 bps at 4h)".
- Netting. Fees and slippage are charged on the net position change per (coin, fill instant, fill type, native cost),
  not per tranche leg.
- Fills net only when they execute at the same 5m open. Tranches on a coin that expire and open at the same open on the
  same side trade only the difference of their weights (nothing when the weights are equal). A stop, take-profit or
  maker exit never nets.
- Netting runs once over a run's included tranches, across walk-forward folds.
- Booking. A fill group is booked on the UTC day [d_start, d_end) that holds its instant. Each group's cost is allocated
  to its legs pro rata to abs(weight) wherever a per-tranche cost is needed (the joint-shift null, trade tables).
- Slippage per coin, the same at every interval: BTC 1, ETH 1, BNB 2, SOL 2, XRP 2, DOGE 2, AVAX 3, DOT 3, LINK 3, ADA 5
  bps on taker fills. Each is at least twice the sum of the half-spread and the $1k-order impact measured on 2026-10-28,
  from 6 order-book snapshots on one calm day (disclosed).
- Item 6's slippage x2 applies to this table. Fees (VIP 0, 2 and 5 bps) and the funding rule are unchanged.
- Classifier label thresholds use each coin's round trip, 2 x (taker + coin slippage).
- The TypeScript-parity functions of r4.costs are unchanged. The research book no longer uses the per-interval budget.

A1.2 PRICED EXITS AND THE HEDGE INTERVAL. It amends "r_EW is the mean log return over the SAME interval".
- A stop, take-profit or maker exit fills inside a 5m bar. It is stamped at that bar's close, which is on the 5m grid.
- A model, flow or funding close fills at the 5m open at tau + 10 minutes and is stamped at that open.
- The coin leg is priced at the fill. The basket interval ends at the stamp.
- An intrabar fill pays no settlement at its stamp: funding sums the settlements in (entry, stamp).
- A basket with no coin priced at both ends is never taken as 0. In the book it raises an error. The joint-shift null
  drops the tranche and counts it. In D every 5m instant has all 10 coins (counted 2026-10-28).

A1.3 CLASSIFIER SIDE RULE. It defines "side rule" for the logistic and LightGBM models.
- Two binary models are fit on the same rows. The up label is the return above the round trip and the down label is the
  return below minus the round trip. For the triple barrier, each side's own take-profit counts, from that side's own
  run.
- With m the declared margin over each side's training base rate:
  - long if p_up - base_up > m and exceeds p_dn - base_dn;
  - short in the mirror case;
  - else flat, and a tie is flat.
- Ridge is unchanged.

A1.4 FAMILY D BOOK. It specifies "Family D replaces the slot rule".
- Weights are centred average ranks of the model score across the coins with a sample at T, scaled so sum abs(w) = 1
  exactly.
- Fewer than 6 coins means cash. The median coin of an odd count is flat.
- The size rule does not apply. Ranking never splits a decision time across folds or CPCV groups.
- Item 5's jackknife drops a coin's tranches without re-ranking.

A1.5 EXITS. It specifies the "exit rule" configuration dimension.
- Every exit runs in one bar-by-bar engine. On history it replays closed 5m bars. Live it runs the same rule on new
  data.
- E1. The horizon exit of the TIMING rule.
- E2. Barriers at entry x exp(+-k x sigma_h(T)) with M's sigma_h, k = 1.0.
- E3. A trailing stop at the running favourable extreme x exp(-+k x sigma_h), k = 2.0, with sigma_h at the close of the
  previous 5m bar.
  - Each bar is checked against the trail from earlier bars before the extreme is updated.
  - The trail never loosens.
- X1. A maker order rests at the open of the bar 3 bars before the scheduled exit. It fills on a strict trade-through,
  else taker at the scheduled exit.
- E4, E5 and E6 are evaluated at every 5m close inside the hold. A close fills taker at the open 10 minutes later.
  - E4 closes when its forecast of the remaining net return is below -1.0 x its training residual SE.
  - E5 closes when P(holding beats closing) < 0.35 at 3 consecutive 5m closes. A missing feature resets the count.
    Disclosed: (0.35, 3) replaced a single-check 0.4 after the synthetic planted control of the brief 25e test world
    (the flow-led reversal plant at seeds 31 and 32) measured 53.1% false closes (synthetic data only, 2026-10-28).
  - E4 at 1.0 x SE may rarely or never fire on an entry with no edge. That is reported, not retuned.
  - E6 closes on a taker-buy share 2 SD against the position (12 bars against 30 days), or on a predicted funding
    against the position above 0.05% before the settlement. The prediction uses Binance's formula approximated by the
    simple mean of 5m premium-index closes since the last settlement, with interest 0.01% scaled by the funding
    interval. The flow statistics are a trailing mean and SD over 30 days including the current window, with at least
    80% coverage.
- E4 and E5 models.
  - They are fit per fold (per split in CPCV) on side-symmetric hypothetical holds from every training decision instant,
    4 sampled 5m instants per hold. Labels are the remaining log return net of funding. Holds end before the refit cut.
  - Market features at an instant come from 15m-stride phase-shifted decision bars. Position state updates every 5m.
  - The market features are the configuration's own. The model input is [x, side x x, side, elapsed share, running P&L,
    MFE, MAE], standardised on the training set. E4 is a ridge (alpha 1.0) and E5 a logistic regression on 1[y > 0]. A
    fold with fewer than 1,000 samples falls back to E1 and is counted.
  - A missing feature means hold, and is counted.
- Fills.
  - A stop fills taker at the worse of the level and the bar's open.
  - A take-profit needs a strict trade-through and fills maker at the level.
  - A tie books the stop. A missing sigma means hold, and is counted.
- The weight keeps the configured h. Live stop orders use the contract price, which the replay's kline OHLC reproduces.

A1.6 ITEM 4 FOR PATH-DEPENDENT EXITS. It amends "with the same sizes, sides and holds" for configurations with E2 to E6
or X1.
- The joint shift moves every entry by the same whole-day shift, with the same sides and sizes. It then re-runs the exit
  engine from each shifted entry, using the models of the fold that holds the shifted entry, and recomputes the netting.
- 1,000 draws, p below 0.05.

A1.7 THE LABEL-SHIFT TRIPWIRE.
- Shifts s_k = 30 + 7k days, k = 0 to 99, of every label column against the features: the entry model's labels, and the
  E4 and E5 exit models' in-hold labels. An exit-model training sample keeps its real market features and position
  state, and takes the remaining-return label of the same coin's hold at T + s_k at the same offset into the hold. The
  shift maps by time within each coin and wraps within each coin's sample span.
- In each shifted run, a training row of either model is purged when its shifted label window ends at or after the refit
  minus the 30-day embargo, so no test-period label trains the model. This slightly lowers the tripwire's sensitivity
  (disclosed).
- Features, prices and the book stay real.
- The halt rule is M's: more than 60 positive. The cost-free count is reported. It adds no trials.

A1.8 ITEM 3 VARIANCE, at round close and in calibration. It amends "The variance of trial Sharpes is taken over the
round's alpha-bearing configurations at round close".
- The variance is pooled WITHIN COST CELLS. A cell is (interval, horizon, label, exit, book).
- It uses every cell with at least 2 unique configurations, with degrees of freedom summed over cells.
- N, the identical-configuration rule and the program-count report are unchanged.
- Why: in a simplified synthetic estimate (gate-P-pre-review-2, appendix B, with the old per-interval costs, no netting
  and no D read), cost tiers alone spread trial Sharpes from about -2.6 to -0.4 a day. That makes SR0 about 1 to 2 a
  day, and no configuration could pass by construction.
- The total and cost-free variances are reported beside the pooled one.

A1.9 PIPELINE CALIBRATION, operational definitions. Each prediction is committed before its run, and each run's receipt
carries its commit, which must descend from that prediction commit. The optional-stopping check, the median hold and the
planted control are deterministic synthetic computations whose results at the registration commit are known before
registration. They are acceptance tests of the engine and guard against code changes after it, not predictions. Measured
power of the optional-stopping check: a look-ahead of 15 minutes in the shared feature lookup gives t 3.7 and 9.6 on the
loosened rows, and one of 30 minutes gives t 44 and 48 (synthetic, 2026-10-29).
- Noise.
  - Interval-horizon groups: C1 1h/4h, C2 1h/8h, C3 4h/4h, C4 4h/8h, C5 4h/24h. "Cell" keeps A1.8's meaning.
  - 40 configurations of hash noise features across groups C1 to C5, models ridge, LightGBM, logistic, no-refit ridge
    and the family D score.
  - Every group has at least 2 configurations, and every configuration trades at least 5% of decisions and 1,000
    tranches. The trade floor is checked on the synthetic V panel before registration. A D run below it is reported and
    still counted in V.
  - The cost-free diagnostic uses the within-cell V of the cost-free Sharpes.
  - Gated: M's two bounds, and 0 of 40 pass items 1 to 3.
- Positive.
  - A planted, cross-sectionally demeaned signal enters the 5m prices as a linear drift over each 4h hold, read through
    the feature planted_z.
  - Family: P1 and P2 plus 4 noise decoys.
  - a* is the smallest registered grid amplitude with a power simulation detection rate of at least 0.8 at 1.2 x the
    noise controls' within-cell V on D. The next lower grid amplitude must have been evaluated and failed, unless a* is
    the grid minimum. The power simulation runs on synthetic D-shaped panels. It omits P2, the SPA and the tripwire, and
    uses a 200-draw joint shift.
  - On D, item 3 uses the noise controls' D within-cell V itself, not 1.2 x V, with N = 120.
  - Gated: P1 or P2 passes items 1 to 6, with the tripwire. A miss gets one re-run, only after a code audit, at plant
    seed 20261029 with decoy seeds 2,000,011 to 2,000,014. A second miss is terminal: the pipeline is presumed
    insensitive.
- Exits.
  - E2 to E6 and X1 on one noise entry configuration, under A1.6's null: the base noise_06 (ridge, fixed label, C4, seed
    ordinal 1, 20 hash-noise features), with only the exit changed. Gated: at most 1 of 6 rejects.
  - The six rows share the base entries, so the count mostly reflects the base entries' place in their null. The base's
    own p under the same replay path is reported. A row that never fires repeats E1's null and is reported as such. In
    the block E4 and E5 see only hash noise, so they are expected never to fire on D.
  - Each run must have the base control's entries exactly, an exit replay that reproduces its stored exits, and an
    observed statistic equal to the replay path at zero shift. E4 and E5 runs may not fall back to E1 in any fold.
  - Determinism: a second run of each exit configuration gives identical receipts apart from the runtime, identical
    outputs and identical E4 and E5 coefficients. Both runs share one process, so non-determinism across processes or
    machines is not tested.
  - Optional stopping, on 20 zero-drift synthetic panels of 75 days (seeds 6000 to 6019, 6 coins, daily volatility 2%)
    with a fixed noise entry set of the base's 4h decisions and 8h hold. E4 and E5 fit on each panel's first 60% with
    the features taker_imb_last15 and ret_15m_last and are scored after it. A model therefore learns a look-ahead that
    reaches past the 10-minute fill delay through the feature lookup that training and serving share. The check does not
    see a leak in serving only, a leak in other features, or information inside the fill delay.
  - E4 and E5 run at the registered thresholds and at loosened ones (E4 margin 1e-12 SE, E5 0.5 at 1 close). Gated: no
    row's cost-free mean per tranche differs from 0 (two-sided t-test across panels at 0.01), X1's is not positive, and
    the loosened rows close early on at least 10% of tranches, else the check is not met. A significant mean means the
    exit engine is presumed to use future information. A loosened row below the floor means the check tested nothing.
  - Diagnostics on synthetic panels: the median hold under E4, E5 and E6 is at least 80% of h (E4 and E5 rarely fire on
    these panels, so theirs is met almost by construction), and the planted intrabar control. The plant is a reversal
    visible in 5m taker flow before the price moves (4 panels). Each of E4, E5 and E6 should show a positive increment
    against E1 on planted tranches, close ahead of the reversal on at least 80% of them, and close early on at most 20%
    of unplanted tranches. Panel seeds 7000, 7002, 7004 and 7006, event seeds 7001, 7003, 7005 and 7007, 4 coins, 100
    days, fit on the first 70, 1h decisions, 4h hold. E5's (0.35, 3) was chosen on this plant design at other seeds
    (A1.5), so E5's result here is not an independent check. Disclosed: a first implementation with a different plant (a
    burst with simultaneous flow, false closes counted over all non-adverse tranches) measured E5 false closes of 22 to
    29%. It was replaced because it was not this design.
- Re-tests.
  - Rules: rv-v1, S1, S2, C1, v8 1h and v8 4h, replayed from frozen code with native costs and timing, from 2023-01-01.
  - Betas from the trailing 12 months. Item 3 at the calibration V, labelled a re-read.
  - Native rates, netted under A1.1.
  - PBO not applicable. A rule passes when at least one hurdle is applied and every applied hurdle passes. A rule with
    no applied hurdle is not evaluated. An unavailable or not-applicable hurdle neither passes nor blocks, and is
    listed.
  - Disclosed: v8 stop exits carry no fill price in the harness report and are dropped, which biases the v8 re-tests
    upward. The dropped share is reported.
  - N2, N3 and F1 do not fit (spot inputs, a 30-coin universe).
  - Gated: all 6 fail. A pass means independent evaluation, then round-close re-evaluation.
- lab-v5 null. Gated: a false-crossing rate at most 1/600 in 50,000 paths over 730 days.
- Everything else registered is a diagnostic: a miss triggers a review, not a rejection.
- Trials. Program total after Phase 4: 2,204 + 40 + 6 + 6 + 6 = 2,262. Controls are kind control, outside the
  alpha-bearing N and outside the round-close V (calibration uses the noise controls' own within-cell V).
- Re-tests are alpha-bearing within the 12 re-test budget. They count in N but, as singleton cells, add nothing to V.
- The family B Tier B noise mini-control is deferred to before family B runs, as a later counted control.

A1.10 $100-ACCOUNT LAYER, REPORT ONLY.
- Each run's tranches are replayed on a $100 account at 10x, 20x and 50x with today's lot sizes and minimum notionals,
  cross margin and liquidation. Intrabar exits are priced at their fill.
- It never gates.

A1.11 READS. This amendment adds reads of D's daily log-return covariance and betas (second moments only, as for the
lab-v5 null), the calibration runs above, and nothing of H.

AMENDMENT 2 (2026-10-30, owner-approved and SIGNED by the owner on 2026-10-30 (session 44) for this text). It is
written after the synthetic V panel and the 2 reference panels (calib-synth-v at 81e3c5b0, recorded in
records/synth_v_81e3c5b0.json) and before any D noise run. It changes which noise controls enter the calibration V and
defines one registered diagnostic. It changes no threshold, span, budget or H rule.

A2.1 TRADE-FLOOR FAILURES AND THE CALIBRATION V. It amends A1.9 "A D run below it is reported and still counted in V".
- On the synthetic V panel, noise_26_logit_C2_s1, noise_27_logit_C2_s2, noise_28_logit_C4_s1 and noise_29_logit_C4_s2
  fail the trade floor at attempts 0, 1 and 2 (at most 1,635 tranches and 2.1% of decisions). Their attempt 2
  configurations are the registered members of the noise set.
- These 4 registered failures stay in the noise set, the ledger, items 1 to 3, the PBO, the joint-shift null and every
  report. They are left out of the calibration V:
  - the within-cell V of item 3, for the noise controls and for the positive control;
  - the power simulation's 1.2 x V, and SR0;
  - the total and cost-free variances reported beside it.
- A D noise run below the floor that is not one of the 4 is reported and still counted in V, as A1.9 says.
- Why: every trading noise control loses to costs (daily Sharpe -0.17 to -0.95 on the V panel), and a control that does
  not trade has a daily Sharpe near 0. Within their cells the 4 alone raise the synthetic within-cell V from 0.0060 to
  0.0310, and SR0 (N = 120) from 0.20 to 0.46 a day. That is the cost-tier spread that A1.8 removes between cells,
  entering again within them. The larger V would choose a larger planted amplitude and make the positive control a
  weaker test.
- Synthetic values under this amendment (V panel, 36 controls): within-cell V 0.0060 (df 25), SR0 0.20.

A2.2 THE REFERENCE-PANEL DIAGNOSTIC. It defines noise_joint_shift_reference_panels ("The joint-shift rejection count
sits inside the empirical count of 2 synthetic D-shaped panels").
- The reference panels 3,997 and 3,998 reject 1 and 2 of the 40 noise controls at p < 0.05 (1,000 draws each).
- The diagnostic is met when D's rejection count is from the smaller to the larger of the two, inclusive: 1 to 2.
- It stays a diagnostic. A miss triggers a review, not a rejection. M's gated bound of at most 6 is unchanged.
"""

from __future__ import annotations

from typing import Any

# Times in epoch ms (UTC)
DEV_START: int = 1640995200000
DEV_END: int = 1782864000000
TIER_B_START: int = 1672531200000
WF_FIRST_REFIT: int = 1672531200000
WF_FIRST_REFIT_TIER_B: int = 1704067200000
H_START: int = 1577836800000
H_END: int = 1640995200000

UNIVERSE: tuple[str, ...] = (
    "BTCUSDT",
    "ETHUSDT",
    "BNBUSDT",
    "SOLUSDT",
    "XRPUSDT",
    "ADAUSDT",
    "DOGEUSDT",
    "AVAXUSDT",
    "DOTUSDT",
    "LINKUSDT",
)

H_EARLY_COINS: tuple[str, ...] = (
    "BTCUSDT",
    "ETHUSDT",
    "XRPUSDT",
    "LINKUSDT",
    "ADAUSDT",
    "BNBUSDT",
)

DECISION_INTERVALS_MS: dict[str, int] = {
    "1h": 3600000,
    "4h": 14400000,
}

ENTRY_DELAY_MS: int = 600000

HORIZONS_MS: dict[str, tuple[int, ...]] = {
    "1h": (14400000, 28800000),
    "4h": (14400000, 28800000, 86400000),
}

CPCV_GROUPS: int = 6
CPCV_TEST_GROUPS: int = 2
CPCV_EMBARGO_MS: int = 2592000000
CPCV_LONG_LOOKBACK_FEATURES: tuple[str, ...] = (
    "trend_1d",
    "atr14_1d",
    "dist_pdh",
    "dist_pdl",
    "dist_poc",
    "trend_4h",
    "funding_z30d",
)
FINALIST_DESCRIPTIVE_CPCV_EMBARGO_MS: int = 17280000000

WF_LOOKBACK_ARMS_MONTHS: tuple[int | None, ...] = (12, 24, None)
WF_LOOKBACK_ARMS_MONTHS_TIER_B: tuple[int | None, ...] = (12, None)

TRIPLE_BARRIER_K: float = 1.0
SIGMA_TRAILING_MS: int = 86400000

BUDGET: dict[str, int] = {
    "A": 48,
    "B": 24,
    "D": 12,
    "E": 24,
    "retests": 12,
}

BUDGET_FORECAST_C: int = 12
DSR_TRIALS_MIN: int = 120
PROGRAM_TRIALS_BEFORE: int = 2204
MAX_FINALISTS: int = 3
MAX_FORECAST_FINALISTS: int = 1
MAX_H_READ_IDS: int = 4

BAR: dict[str, int | float] = {
    "cpcv_paths_positive_min": 4,
    "pbo_max": 0.25,
    "cscv_groups": 16,
    "dsr_min": 0.95,
    "random_entry_draws": 1000,
    "random_entry_shift_min_days": 7,
    "random_entry_p_max": 0.05,
    "spa_reps": 1000,
    "spa_mean_block_days": 10,
    "spa_p_max": 0.05,
    "label_shift_min_days": 30,
    "label_shift_perms": 100,
    "symbols_positive_min": 7,
    "stress_fee_mult": 1.5,
    "stress_slippage_mult": 2.0,
}

BAR_FORECAST: dict[str, Any] = {
    "dm_p_max": 0.05,
    "coverage_levels": (0.80, 0.95),
    "coverage_tolerance": 0.02,
    "symbols_min": 8,
    "ewma_halflife_windows": 7,
}

STAY_OUT: dict[str, int | float] = {
    "vol_percentile": 0.90,
    "vol_percentile_lookback_days": 90,
    "range_cost_multiple": 3.0,
    "range_share_min": 0.60,
}
STAY_OUT_BLOCK_DAYS: int = 10

CONTROLS: dict[str, int | float] = {
    "positive_detection_power_min": 0.80,
    "noise_configs": 40,
    "noise_pass_max": 5,
}
NOISE_SHIFT_REJECT_MAX: int = 6

REFIT: dict[str, Any] = {
    "rule": "paired_block_bootstrap_90ci_entirely_above_zero",
    "mean_block_days": 10,
    "reps": 1000,
}

TIER_B_STAMP_MS: int = 300000

H_RULES: dict[str, int | float] = {
    "min_trades_per_coin": 30,
    "listing_burn_in_days": 60,
    "coin_share_min": 0.6,
    "power_min": 0.5,
}
H_NULL_P_MAX: float = 0.05 / 3

JOINT_SHIFT_GRID_MS: int = 86400000
HOLDOUT_LEDGER_PATH: str = "~/round4-out/holdout-reads.jsonl"
LABEL_SHIFT_TRIPWIRE: int = 60

LAB_V5: dict[str, Any] = {
    "alpha": 0.005,
    "max_slots": 3,
    "threshold": 600,
    "warmup_bets": 30,
    "scale_sd_multiple": 4.0,
    "loss_floor_x": -2.0,
    "statistic": "daily_beta_hedged_book_return",
    "horizon_months": 24,
}

__all__ = [
    "BAR",
    "BAR_FORECAST",
    "BUDGET",
    "BUDGET_FORECAST_C",
    "CONTROLS",
    "CPCV_EMBARGO_MS",
    "CPCV_GROUPS",
    "CPCV_LONG_LOOKBACK_FEATURES",
    "CPCV_TEST_GROUPS",
    "DECISION_INTERVALS_MS",
    "DEV_END",
    "DEV_START",
    "DSR_TRIALS_MIN",
    "ENTRY_DELAY_MS",
    "FINALIST_DESCRIPTIVE_CPCV_EMBARGO_MS",
    "HOLDOUT_LEDGER_PATH",
    "HORIZONS_MS",
    "H_EARLY_COINS",
    "H_END",
    "H_NULL_P_MAX",
    "H_RULES",
    "H_START",
    "JOINT_SHIFT_GRID_MS",
    "LAB_V5",
    "LABEL_SHIFT_TRIPWIRE",
    "MAX_FINALISTS",
    "MAX_FORECAST_FINALISTS",
    "MAX_H_READ_IDS",
    "NOISE_SHIFT_REJECT_MAX",
    "PROGRAM_TRIALS_BEFORE",
    "REFIT",
    "SIGMA_TRAILING_MS",
    "STAY_OUT",
    "STAY_OUT_BLOCK_DAYS",
    "TIER_B_STAMP_MS",
    "TIER_B_START",
    "TRIPLE_BARRIER_K",
    "UNIVERSE",
    "WF_FIRST_REFIT",
    "WF_FIRST_REFIT_TIER_B",
    "WF_LOOKBACK_ARMS_MONTHS",
    "WF_LOOKBACK_ARMS_MONTHS_TIER_B",
]
