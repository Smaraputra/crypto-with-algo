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

AMENDMENT 3 (2026-10-31, owner-approved and SIGNED by the owner on 2026-11-01 (session 44) for this text). It is written
after the D noise evaluation and the D power simulation, and before any native re-test export or evaluation. It
changes the data from which four of the six re-tests take their decisions, fixes how v8's exits are stamped, and sets
how the re-test receipts bind to code. It changes no threshold, span, budget, prediction or H rule.

A3.1 DECISION SOURCES OF THE RE-TESTS. It amends A1.9 "Rules: rv-v1, S1, S2, C1, v8 1h and v8 4h, replayed from frozen
code with native costs and timing" for the data that frozen code reads, and supersedes calibration spec section 6's
"--price perp" for v8.
- D (datasetHash 11c87b9c...) holds perp klines and premium index (5m to 1d), funding, metrics and flow. It holds no
  spot candles, HTF candles or snapshots.
- C1 scores spot 1h candles, and v8's harness reads spot candles, HTF candles and snapshots: on D both stop at the
  first missing file. rv-v1's registered treatment (calibration spec section 6) needs the repaired rv2 data and the
  reviewed resolutions file, which the brief 29a exporter requires.
- These four take their DECISIONS (entry and exit times, sides, sizes, and stop exits) from the dataset their frozen
  code was last run on, fixed by datasetHash:
  - rv-v1: the repaired re-validation export ~/rv2-ds, bc3566f4c6c6b0fe09e0c6984fca4aa8ba4f4c3a3fe8837826aad57f9c4137c8,
    with the reviewed resolutions file, sha256 bc4d30b25232a572555c9b09fb00972dab75bdff7c55ba4818d598196f3f0657
    (checked in code). Its weights come from its native equity path on rv2-ds prices and funding.
  - C1: the Round 1 export ~/nv1-ds, 414fef1ee6ccf45fcb6e6a7e25ad8a5c3a3ea24176b40cfd7158e8cf2a906e5f, spot 1h.
  - v8 1h and v8 4h: the direction-exit export ~/dx-ds,
    48ff79609080f11a48c45822f27cd609818b913b2d42455cddf4ea1ef4806e93,
    with the harness on spot prices, as the recorded direction-exit study ran. dx-ds holds no perp bars.
- S1 and S2 read D: their inputs (perp 1h klines with taker volume, and funding) are in D.
- The BOOK of every re-test is unchanged. It prices the exported tranches on D's perp 5m opens and D's funding from
  2023-01-01, under A1.1. A re-test refuses any tranche whose booked entry or exit instant has no D 5m open for its
  coin. A receipt's dataset_hash stays D's. A new field, decision_dataset_hash, records the decision source, and the
  dossier checks it against this list. Each export records the commit that made it, export_commit, and a receipt
  refuses an export from another commit.
- v8 EXIT INSTANT. The harness fills a time stop, and the close of a hold still open at the last bar (end_of_data),
  at that bar's close, and stamps it with the bar's open time. The 29a exporter booked that stamp, which closed every
  v8 trade one bar early (23 of 24 hours at 1h, 29 of 30 bars at 4h). The export now books both at exitTime + the
  interval, the instant of the fill.
- Reads: decisions use [2022-01-01, 2026-07-01) plus the warm-up each frozen code needs:
  - spot 1h from 2021-10-14 (the holdout A clip) for C1 and v8 1h;
  - spot 4h and 1d candles, HTF 4h and 1d, snapshots and funding settlements from 2021-10-01 for v8.
  rv-v1's panel loads its source files whole (to 2026-10-13) and uses only the span grid. Funding rows after the span
  can serve as spacing neighbours when an interval is derived. rv-v1's export re-checks its resolutions against
  Binance REST and halts on any disagreement. No perp bar before 2022-01-01 is read, so none of them reads H.
- Funding by role. rv-v1's carry factor and native nets use rv2-ds funding with the reviewed resolution. v8's harness
  uses dx-ds funding settlements and snapshot funding rates. S1 and S2 use D's funding. Every book uses D's funding.
- Disclosed:
  - the three sources were exported from production on 2026-10-15 (rv2-ds), 2026-10-18 (nv1-ds) and 2026-10-11
    (dx-ds), before D (2026-10-24). A revision of a source row between those exports and D's is not reconciled. Its
    direction is unknown;
  - C1's scores restart from 2021-10-14 rather than from 2017 as in Round 1, so a recursive indicator can differ
    slightly from the recorded scores;
  - v8's stop logic sees spot prices, as in its recorded study. That changes which stop exits A1.9 drops (no known
    direction) while its book is priced on D's perp bars;
  - C1 and v8 decide on spot closes and are booked at D's perp opens at the same instants. A zero-delay fill earns part
    of the bid-ask bounce in its own market, and the cross-market mapping removes most of that, which likely biases
    these two re-tests down, toward the predicted fail. At holds of 24 hours or 30 bars the effect is small. This is
    plausible, not measured.

A3.2 CODE BINDING OF THE RE-TESTS. It amends the code freeze (one commit, r4 source digest, requirements lock and
library versions across every dossier input) for the re-tests only.
- The re-tests, the exports and the dossier run at a later commit, C3, that carries this amendment's code. Every
  other dossier input stays at the frozen commit 5250b8eaf30b5bb4cf073bbcb9eb2529fb8b8701.
- The dossier accepts the two commits only when the lead's commit-order evidence carries a code_change record:
  - its fields are from (the frozen commit, all 40 characters), to (C3, all 40 characters), is_ancestor (true),
    to_source_sha256 (the r4 source digest of a clean git archive of C3) and files;
  - its files all lie in this list:
    - scripts/research/py/r4/natives.py and scripts/research/py/r4/calibration.py;
    - scripts/research/py/r4/method.py, by appending to its docstring only;
    - scripts/research/round4-native-export.ts and its test;
    - files under scripts/research/py/tests/;
    - changelogs/CHANGELOG.md.
- Every re-test receipt, and the dossier run itself, must have the r4 source digest to_source_sha256. Re-tests at
  the frozen commit with another digest are refused. A code_change on re-tests that did not move is refused.
- The requirements lock and the library versions must still be one across every input.
- A test compares the source text of every top-level node of every r4 module with its 5250b8ea text, through a
  fixture of sha256 digests that a committed generator rebuilds from git. Only these may differ:
  - calibration.py, changed: _bind_commit_order, _check_code_freeze, _validate_commit_order, _validate_retests,
    write_dossier;
  - calibration.py, new: A3_CODE_CHANGE_FILES, A3_CODE_CHANGE_PREFIXES, A3_FROZEN_COMMIT, _prefix_match,
    _check_retest_sources, _validate_code_change;
  - natives.py, changed: read_export, evaluate_retest, run_retest;
  - natives.py, new: NATIVE_DECISION_SOURCES, RV_V1_RESOLUTIONS_SHA256, decision_source;
  - method.py: its module docstring only.
- The Gate P review reads the full 5250b8ea..C3 diff of every listed file, the exporter and its test included, and
  regenerates the node fixture from git.
- The natives prediction keeps its text and its registration. Its receipts at C3 descend from that registration
  commit.

AMENDMENT 4 (2026-11-02, owner-approved and SIGNED by the owner on 2026-11-02 (session 44) for this text). It is written
after the Gate P post-run review (PASS WITH CONDITIONS, gates/gate-P-post-run-review.md) and before any Phase 5 read
of D. It answers that review's conditions C1 to C4. It changes four things:
- the funding of the drift-free series' hedge leg (A4.1);
- the variance and dependence correction in item 3 (A4.2);
- the code binding of Phase 4, which is re-run at one commit in place of A3.2's two-commit path (A4.3);
- the counting of bit-identical repeats (A4.4).
It changes no threshold, span, budget cap, prediction or H rule. A4.1 and A4.2 were both chosen after Phase 4 on D
was seen, which is disclosed as a forking path.

A4.1 FUNDING ON THE HEDGE LEG. It amends the drift-free series' funding (M, and A1.1's funding rule).
- The beta hedge was notional and paid no funding. On D the four never-refit noise controls (noise_30 to noise_33, a
  ridge fit once) held short books (91% to 100% of trades short) and collected 1.2 to 1.5 bps a day of carry through
  the coin leg alone.
  - noise_30 and noise_31 reached net daily Sharpes of +0.51 and +0.28. The other slot-book controls of their cell
    scored -0.53 to -0.67, and the cell's two logit floor failures, near zero, are outside V by A2.1.
  - The four account for 97% of the within-cell V: 0.0597 with them, 0.00186 without.
- From this amendment, each tranche's hedge position, -beta x w in the equal-weight basket, pays the basket's
  funding: funding_hedge = beta x w x f_EW.
  - f_EW is the mean, over the basket coins used for r_EW in that interval (priced at both ends), of each coin's
    summed settlement rates in the coin leg's window: (entry, exit], with an intrabar exit excluding its stamp.
  - A basket coin enters f_EW only when its settlement record covers the window. No missing settlement is taken
    as 0, and the number of coins used is recorded.
  - The daily drift-free series and the joint-shift null each add the term, implemented separately, and a parity
    test binds them.
  - The daily frame's funding column is coin plus hedge, with funding_coin, funding_hedge and the basket count beside
    it.
  - lab-v5's wait for settlements (up to 72 h) extends to the basket coins.
- With equal weights on all ten coins and betas estimated against the same basket, the betas sum to ten and the
  hedge funding cancels the coin funding exactly. noise_30 and noise_31 are such books on almost every day (99.99%
  and 99.6% of their trades short).
- The hedge stays notional for costs, so the series is an attribution series, not an executable net return
  (disclosed). Phase 5 reports a netted hedge-cost estimate beside every item 1 pass.
- Training labels are unchanged. They are coin-level and never used the hedge.

A4.2 ITEM 3 VARIANCE. It amends item 3's V ("the variance of trial Sharpes", with A1.8's within-cell pooling and
A2.1's exclusions).
- SR0 = sqrt(V) x a_N is the expected maximum of N trial Sharpes without skill when V is the spread that estimation
  noise gives around zero. On D the registered V was 0.0597, 97% of it from the four controls of A4.1, which put
  SR0 at 0.634 a day (about 12 annualized), a bar no realistic edge clears. The Opus Gate P post-run review, Codex
  and Gemini via agy reviewed this.
- From this amendment, item 3 uses V0 = 1 / (T - 1). T is item 3's n for the candidate: the calendar days of its
  span, with no-bet days counted as zero. V0 is the sampling variance of a daily Sharpe estimate when the true
  Sharpe is zero (the probabilistic Sharpe radicand is 1 there).
  - Serial dependence: lambda = max(1, 1 + 2 x sum over k = 1..10 of (1 - k/11) x rho_k), with Bartlett weights over
    10 lags.
    - rho_k is the lag-k sample autocorrelation of the series item 3 evaluates, taken about the full-series mean and
      divided by the lag-0 sum of squares. A zero-variance series has lambda = 1.
    - Item 3 multiplies both V0 and the variance of the candidate's Sharpe estimate (its radicand over T - 1) by
      lambda. That is the same as replacing T - 1 by (T - 1) / lambda.
    - lambda is computed for every series item 3 evaluates, including the program-count report, the cost-free
      diagnostic, the power simulation and the positive control.
    - lambda is never below 1, so it never loosens the bar. Ten lags understate longer dependence (disclosed).
  - N stays as registered: max(120, the round's alpha-bearing count), and 2,204 + N for the program count.
- Constants on D (T = 1,277), with lambda = 1: V0 = 1/1,276 = 7.83699e-4, and 1.2 x V0 = 9.40439e-4. SR0 is 0.0726
  a day at N = 120 and 0.0976 on the program count. With Gaussian moments, a pass needs a daily Sharpe of about
  0.119 at N = 120 (about 4.24 standard errors) and 0.144 on the program count (about 2.3 and 2.7 annualized). At
  that bar, the union bound puts a false pass among 120 trials at about 0.13% at most, under any correlation between
  them, so keeping N is conservative.
- V0 is used:
  - in item 3, for every candidate and control;
  - in the noise evaluation and its cost-free diagnostic;
  - in the positive control on D, at V0;
  - in the power simulation's walk and curve, at 1.2 x lambda x V0, the margin passed explicitly rather than as an
    estimated V;
  - in the native re-tests.
- The dossier checks V0 by its formula. The within-cell V of A1.8 and A2.1 is still computed and reported beside
  V0, as a diagnostic.
- V0 is analytic, has one registered parameter (10 lags), and is fixed before any Phase 5 read.

A4.3 PHASE 4 RE-RUN AT ONE COMMIT. Phase 4 is re-run in full at the commit that carries this amendment's code (C4),
with the registered configurations, seeds and predictions. That covers the 40 noise controls on D and their
evaluation, the power simulation and curve, the exit block, the daily null, the positive control on D at the new
a*, and the six native re-tests from A3.1's decision sources. Every dossier input is then at C4, so A3.2's
two-commit path is not used, and A3.1's decision sources are unchanged.
- Code binding. A test compares the source text of every top-level r4 node at C4 with its 5250b8ea text. Only A3's
  nodes and these may differ:
  - book.py: beta_hedged_daily;
  - bar.py: item3, joint_shift_stats, joint_shift_null, family_report;
  - stats.py: deflated_sharpe and probabilistic_sharpe, plus a new long_run_variance_factor;
  - cli.py: run_wf (the daily frame's new funding columns) and main (routing V0 and the margin);
  - calibration.py: evaluate_noise, _cost_free_diagnostics, _curve_entry, power_simulation,
    _check_power_parameters, _positive_preflight, positive_control, write_dossier and _validate_retests, plus new
    A4 constants and the constants POWER_STOP_V and SYNTH_V_A2;
  - natives.py: evaluate_retest.
  A3's nodes keep their b23a7b26 text. requirements.lock and the library versions are unchanged from 5250b8ea. Any
  other change needs a further amendment.
- Blocking checks. If any one fails, the re-run stops for review:
  1. the noise and exit runs' tranches, and their daily gross_hedged, fees, slippage and costs, are identical to
     their 5250b8ea runs, and funding_coin equals the old funding column;
  2. the power-simulation receipts are identical to 5250b8ea's, apart from the commit, source digest and runtime,
     for every amplitude both evaluate (synthetic funding is zero);
  3. the daily null reproduces 16 crossings in 50,000 paths;
  4. the native exports are identical to b23a7b26's, apart from export_commit;
  5. the book against joint-shift parity test passes with the hedge term;
  6. the mean total funding (coin plus hedge) of noise_30 and noise_31 is within 0.05 bps a day of zero.
- The positive control's decisions change with its new amplitude a*, which changes its planted data, labels and
  fits. It is judged on its registered predictions only.
- The registered predictions stand, gated:
  - at most 5, and 0 of 40, noise controls pass items 1 to 3;
  - at most 6 reject the joint shift;
  - the positive control is detected at a*;
  - all 6 natives fail;
  - the daily null's rate is at most 1/600;
  - at most 1 of 6 exit controls rejects;
  - optional stopping is met.
  The diagnostics are as registered. The daily null's "at most 10 crossings" is expected to miss again, at 16.
- If any noise control passes items 1 to 3, the 0-of-40 gate fails: the pipeline is presumed defective and goes to
  review, and nothing is tuned.
- A native pass likewise means the pipeline is presumed defective (A1.9). v8-4h is the closest: it needs about
  +1.78 bps a day more to pass at V0, against a worst-case bound on its hedge term of about 1.6 bps (typically about
  0.3).
- The dossier recomputes each re-test's hurdle flags, span, trial count and lookback from their values.
- The 5250b8ea record and its Gate P post-run review stay on file. Gate P is decided again on the C4 re-run, by an
  Opus post-run review.

A4.4 COUNTING AND THE GATE P RECORD. It amends M's "one per re-run after a code fix" for bit-identical repeats.
- The s1, s2 and c1 re-tests at 4d75535f and 1c7009d0 reproduced the b23a7b26 receipts in every field except commit
  and export_summary_sha256, and their export summaries differ only in export_commit
  (phase4-results/superseded_retests_diff.json, with each receipt's sha256). They had the same decisions, code
  digest, seeds and outcome. A run that reproduces an earlier run's outcome bit for bit computes no new outcome and
  is not counted. v8-1h raised before evaluating, both times, and computed no outcome.
- The C4 re-run counts as M's re-runs after a code fix: 52 controls (40 noise, 6 exit, 6 positive-control runs) and
  6 re-tests. The ledger goes from 2,274 to 2,332, and the re-test family reaches its cap of 12.
- No re-test slot remains.
  - A C4 native that raises before computing an outcome is not counted, and may be fixed and run.
  - A C4 native that needs a fix after computing an outcome is not re-run. Its C4 and b23a7b26 outcomes are both
    reported, the rule is marked not evaluable at C4, and the Gate P review decides whether the natives prediction
    can still be judged.
- The program-count DSR keeps 2,204 + N (disclosed).
- The re-run's record carries the Gate P post-run review's disclosures (findings 3, 4, 6, 9 and 11) and the C1
  carry analysis (phase4-results/c1_carry_analysis.json).

AMENDMENT 5 (2026-11-03, owner-approved and SIGNED by the owner on 2026-11-03 (session 44) for this text). It is written
after the Gate P review of the C4 re-run (PASS WITH CONDITIONS, gates/gate-P-c4-post-run-review.md) and before any
Phase 5 read of D. It answers that review's conditions C2 and C3 and a parity defect found by the Codex second opinion,
and sets the record of condition C1. It changes four things:
- the code binding, extended from Phase 4 to Phase 5 (A5.1);
- the method of A4.1's netted hedge-cost estimate (A5.2);
- the basket of the joint-shift null, aligned with the book's (A5.3);
- the Gate P record (A5.4).
It changes no threshold, span, budget cap, prediction, H rule, Phase 4 outcome or ledger count.

A5.1 CODE BINDING FOR PHASE 5. It extends A4.3's binding ("Any other change needs a further amendment") to Phase 5.
- Gate P accepted the pipeline at C4 dfe1ebf5 (r4 source digest de431740...). C5 is the commit that carries this
  amendment's code.
- Frozen code. Every top-level node and other top-level statement of every r4 module present at C4 keeps its C4
  text, and no such module gains or loses one, except:
  - bar.py: joint_shift_stats and joint_shift_null take their C5 text (A5.3).
  - method.py: its module docstring, by appending signed amendments only.
  - cli.py and pipeline.py may gain nodes and imports, and these extension nodes may change: pipeline.py
    RunConfig, run_config_from_raw, load_panel, decision_samples, _make_model, _binary_labels, fit_side_model,
    _get_decisions and _make_tranches, and cli.py run_wf, run_tripwire and main.
- An extension node changes only by adding a branch that no C4 configuration and no configuration already run on D
  reaches, selected by configuration values the family declares in its ledger commit, for M's configuration
  dimensions (model, hyperparameters, features, label, threshold, side rule, size rule, family C filter, exit). main
  may also gain subcommands that only dispatch to new code. Apart from A5.3, the drift-free book, the netting set,
  fold betas, training windows, refit arms, CPCV paths, items 1 to 6, the seeds and the digest stay as at C4.
- r4/hedge_cost.py (A5.2) is frozen at its C5 text.
- New code. A family adds new r4 modules, which read data only through r4.data's loaders. A family that needs a
  feature outside features.py computes it in its own module, and a test applies causality.assert_future_invariant
  to it with each input's closing rule: its bar interval, 0 for settlements, TIER_B_STAMP_MS for Tier B rows. A
  directional family's labels are derived at fit time from tripwire.LABEL_COLUMNS. E4 and E5 apply only to
  configurations whose features are features.py columns or hash features. Code for a criterion with no C4
  implementation (family C's forecast criteria and stay-out flag) has tests against M's text.
- Family registrations. Family D's weights and band, where they differ from A1.4 (centred ranks with the sum of
  abs(w) at 1), need a further amendment, and family B's Tier B noise control (A1.9) is registered with its
  configurations and bounds, each before that family's first D read.
- Review. Before a family's first D run, an Opus review of the diff from C5 to the family's code commit confirms
  these rules. From the family's first D outcome its code is frozen for it, and a change is a re-run (M).
- Reproduction check (blocking). Before any Phase 5 D outcome is computed under a source digest, that digest
  reproduces in the registered research image, into a new directory, the C4 runs noise_00_ridge_C1_s1,
  noise_12_lgbm_C2_s1, noise_22_lgbmtb_C4_s1, noise_28_logit_C4_s1_alt2, noise_30_noref_C2_s1, noise_36_d_C4_s1,
  exit_0_E2_noise_06_ridge_C4_s1 and exit_3_E5_noise_06_ridge_C4_s1. For each, tranches.parquet, daily.parquet and
  folds.json are identical, receipt.json is identical apart from commit, source_sha256 and runtime_s, and the joint
  shift at its C4 seed and 1,000 draws gives exactly the observed statistic, p and drop share of noise_eval.json or
  exit_block.json, with the exit rows' zero-shift identity. Each reproduction is recorded under records/ with its
  digest. One that matches computes no new outcome and is not counted (A4.4). One that differs stops Phase 5 for
  review, is reported and counts as a control re-run.
- Runs and seeds. Phase 5 D runs start only from committed entry points, and run_wf receives no panel but
  load_panel's for the manifest's dataset. The family index of the SPA seed is A 0, B 1, C 2, D 3, E 4, and every
  Phase 5 configuration carries a joint_shift_seed fixed in the commit that declares it. A report with other seeds
  is void.
- requirements.lock and the library versions stay as at C4.
- One node guard against a C4 fixture of every module replaces the A3 and A4 guards. It allows only the changes
  above and pins hedge_cost.py and the two bar nodes to their C5 digests.
- Any other change to frozen code needs a further amendment.
- Disclosed: CPCV path costs net within each test group, so fills at a path's five group boundaries do not net
  (conservative, kept as at C4).

A5.2 THE NETTED HEDGE-COST ESTIMATE. It defines A4.1's "netted hedge-cost estimate beside every item 1 pass".
- Hedge legs. Over each daily part of its life, each tranche of the run's netting set holds -beta x w / n in each of
  the n coins of that part's basket (the coins used for r_EW, A1.2), with beta the book's beta for that tranche. The
  legs fill at 5m opens, never intrabar: the coin leg's entry instant, each UTC midnight inside the tranche, and the
  hedge end (the stamp, or the next 5m boundary for a priced exit). Where consecutive parts share a basket the
  midnight legs cancel in the netting. Where the basket changes, every basket coin trades the difference.
- Fills. Hedge legs are taker fills at A1.1's taker fee (5 bps) and the coin's A1.1 slippage. Coin legs keep their own
  fill types.
- Netting. A1.1's netting runs once over the union of a run's coin legs and hedge legs, per (coin, fill instant, fill
  type, native cost), so hedge legs net against each other and against coin legs.
- Estimate. H_d = netted fees and slippage of the coin and hedge legs together minus those of the coin legs alone,
  each booked by A1.1's fill-day rule. H_d is negative where hedge legs offset coin legs. Reported beside every
  item 1 pass, over item 1's walk-forward span with no-bet days zero: the mean of H_d in bps a day and the mean of
  D_d - H_d, the same with fees x1.5 and slippage x2 on D_d's costs and on both terms of H_d, and the same with
  every maker leg repriced as taker before both nettings. It never gates.
- Not modelled (disclosed): hedge drift between fills (no rebalance inside a tranche unless its basket changes),
  lot sizes, and maker hedging. Funding of the hedge is already in D_d (A4.1). D_d - H_d stays an estimate.
- Code: r4/hedge_cost.py builds the hedge legs as Tranche objects with weight_override, skips a zero hedge weight,
  and calls book.netted_costs unchanged. Tests: zero beta gives zero, one tranche gives the closed form,
  offsetting tranches net to zero, a fully hedged equal-weight book gives minus its coin cost, and a basket change
  at a midnight trades only the difference. It is frozen at C5 (A5.1).

A5.3 THE JOINT-SHIFT BASKET. It amends the joint-shift null (M item 4, A1.2, A4.1) so its basket follows M's
interval rule.
- M defines r_EW per interval: "a coin missing a bar at an interval boundary leaves the basket for that interval".
  The book applies it to each daily part of a tranche (book.beta_hedged_daily), with A4.1's settlement coverage
  judged per part. The joint shift judges the basket once over the whole tranche (bar.joint_shift_stats). When a
  basket coin lacks the 5m open at a UTC midnight inside a tranche, or a settlement in one of its parts, the two
  differ. Codex and Opus each reproduced a gap on a synthetic panel. It never occurred at C4: in D every 5m instant
  has all 10 coins (A1.2), and on every day with an open tranche of every C4 run the basket's funding count is 10
  (phase4-c4-results/diag_basket.log).
- From this amendment, bar.joint_shift_stats prices r_EW and f_EW of each observed and shifted tranche part by
  part, split at UTC midnights as the book splits it, with each part's basket by M's interval rule and A4.1's
  coverage judged on the part's window, and sums the parts. The coin leg is priced from entry to exit, as at C4. A
  part with no basket coin priced drops the tranche and counts it (A1.2). A part whose priced coins are all
  uncovered raises for an observed tranche (A4.1) and drops a shifted one, which is counted. A tranche each of whose
  parts has the price basket and the covered set of its whole window is computed whole, with C4's arithmetic.
- A shifted tranche whose own coin's settlement record does not cover its window (A4.1's rule) is dropped and
  counted, as M's "lands on missing data" requires.
- A test binds book-to-null parity to 1e-12 for tranches whose basket changes inside them (a basket coin missing a
  midnight open, a basket coin missing a settlement in one part, a listing), on the plain path and on the
  exit-replay path with an intrabar exit in a later part, where the zero-shift statistic equals the observed one
  exactly. A second test drops a shifted tranche that lacks its own settlement.
- bar.joint_shift_stats, and bar.joint_shift_null for its docstring, are the only frozen nodes A5 changes. The
  reproduction check of A5.1, joint shift included, runs at C5.

A5.4 THE GATE P RECORD. The Gate P record of A4.4 is scripts/research/py/records/gate_p_c4.json, committed with C5
before any Phase 5 D read. It states Gate P's decision at C4 (PASS WITH CONDITIONS) and the part of this amendment
that meets each condition, carries the text of the C4 review's condition C1 disclosures (its findings 2, 5 to 10,
13 and 14, and the first review's findings 3, 4, 6, 9 and 11 at C4) and of the C1 carry analysis, lists the open
recommendations, and gives the sha256 of each untracked file it rests on (the C4 post-run review and both second
opinions, the dossier, c1_carry_analysis.json, superseded_retests_diff.json) and of the C4 run files the
reproduction check compares against. A test checks that it parses and carries each item.

AMENDMENT 6 (2026-11-05, owner-approved and SIGNED by the owner on 2026-11-05 (session 45) for this text). It is written
after the family A result (0 of 45, records/family_a_result_b011ea1e.json) and the family C result (finalist
C_LHAR-X_1h, records/family_c_result_c8f5849f.json), and before any family D read of D. The owner chose on 2026-11-05
to run family D with the plan of record's "weights inverse to forecast volatility" and "book-level band", which A1.4 and
A5.1 leave to a further amendment, with the family C finalist as the volatility input and the band values 0.045 and
0.09. It changes four things:
- two family D configuration dimensions, the weight rule and the band (A6.1);
- the volatility input of the inverse-volatility weights (A6.2);
- the book-level band (A6.3);
- the code binding for them (A6.4).
It changes no threshold, span, budget cap, H rule, Phase 4 outcome, ledger count, or rule of a family already run.

A6.1 FAMILY D WEIGHTS AND BAND AS CONFIGURATION DIMENSIONS. It amends "A configuration is fully specified by" and A1.4.
- A family D configuration also specifies its weight rule, "rank" (A1.4, the default and the rule of every
  configuration already run) or "inv_vol" (below), and its band b (A6.3, default 0, no band).
- "inv_vol". At a decision time T the ranked coins are those with a finite score and a finite, strictly positive
  volatility forecast f_i(T) (A6.2). Fewer than 6 means cash.
  - c_i is the centred average rank of the score among them (A1.4), sigma_i(T) = sqrt(f_i(T)), and
    u_i = c_i / sigma_i(T).
  - The long side is scaled so its weights sum to 0.5 and the short side so they sum to -0.5:
    w_i = 0.5 x u_i / (sum of u_j over u_j > 0) for u_i > 0, and w_i = 0.5 x u_i / (sum of abs(u_j) over u_j < 0) for
    u_i < 0. So sum abs(w) = 1 and sum w = 0 to floating-point rounding (tests at 1e-12). A median coin of an odd
    count has c_i = 0 and w_i = 0. All scores tied means cash.
  - Disclosed: the per-side scaling keeps the book dollar-neutral, not volatility-neutral or beta-neutral between the
    sides, and the drift-free series still removes beta drift (M). The weights keep each coin's side from its centred
    rank, but not the rank order of their magnitudes: a higher-ranked coin with a higher sigma can carry less weight.
- A1.4's other rules hold for both weight rules: the size rule does not apply, ranking never splits a decision time
  across folds or CPCV groups, cash at T opens no tranche while the tranches already open run to their exits, and item
  5's jackknife drops a coin's tranches without re-ranking or re-weighting.

A6.2 THE VOLATILITY INPUT.
- f_i(T) is the family C finalist C_LHAR-X_1h's forecast of coin i's realised variance over the 1h window [T, T + 1h),
  evaluated at every T on the 1h grid. Decision times at 1h and 4h lie on that grid.
  - f_i(T) = family_c.apply_fit(fit, x_i(T)), with fit from family_c.fit_fold at the refit of T's UTC month under the
    finalist's registry configuration (refit monthly from 2023-01-01, 24-month lookback, at least 500 training
    windows), and x_i(T) the finalist's design row at T (family_c.design on family_c.component_frame and
    family_c.exog_frame evaluated at the requested T, the terms prepare_window builds on its window grid, extended to
    T, partition end DEV_END).
  - The family D run computes it itself, from load_panel's panel for the manifest's dataset, by calling these frozen
    family C functions (A5.1, frozen since family C's first D outcome). It reads no stored family C output.
- Timing. f_i(T) uses only 5m bars with t + 5m <= T and settlements at or before T (M's TIMING rule), and fits on
  windows with t1 < the refit of T's month. It is evaluated whether or not the window [T, T + 1h) turns out complete.
  family_c.compute_forecasts returns a row only where that window is complete (family_c.py:540), which is data after T,
  so its rows never decide which coins are ranked. The A6.4 test applies causality.assert_future_invariant to f, its
  truncation check included. f is not a model feature: it never drops a training sample and enters only the weights of
  test decisions.
- CPCV ruling. f is not refit per CPCV split. CPCV's purge and embargo protect the score model's training rows, which
  may lie after a test block. The fit behind f_i(T) never uses a window that ends after the refit of T's month, so it
  carries no information from T or later into a test decision. Disclosed (Codex): inside a CPCV split that fit may use
  earlier windows of the same or the other test group, as any trailing feature does.
- Parity (blocking). Before any family D outcome, f must equal the family C run on that run's support. On the rows
  where compute_forecasts at c8f5849f gives a finite f, the run's f has canonical digest
  a6ed91ee3228f2c6645536b7b51c200deb34630e0c71bcd68da4fdfdc37ed6da (276,840 rows, 2023-01-01 00:00 to
  2026-06-30 22:00 UTC).
  - The canonical digest is one SHA-256 over the concatenation, ordered by coin (code-point order) and then T ascending,
    of each row with a finite value. Each row is the coin's UTF-8 bytes, a NUL byte, T in epoch milliseconds as a
    little-endian int64, and the value as a little-endian IEEE 754 float64.
  - The reference was computed from the C_LHAR-X_1h forecasts.parquet of the c8f5849f run (sha256
    696c5ef14613b4fb6964a057bfbae5a88146a0e5a80af1516f39d3e55b86f557, named in receipt cd766aa9...,
    records/family_c_result_c8f5849f.json).
  - r4/family_d.py holds the function, with a test vector. A mismatch stops the run. The run also records the digest
    of f on its full grid in its receipts.
- Missing. A coin without a finite, strictly positive f_i(T) is left out of the ranking at T and enters neither side.
  - The walk-forward lacks f on 2,885 of 30,641 hours for each of nine coins and on 3,603 of 30,639 for BTC
    (family_c_report.json, C_LHAR-X_1h, n_rows minus n_paired, which equals its hours without a finite f on family C's
    support). The cause is the 30-day components after the zero-volume windows. The counts are identical on the nine
    coins, which points to the same hours, so the book is likely cash on about 120 walk-forward days. The run reports
    the full-grid counts.
  - No fit exists before the first refit, 2023-01-01, so CPCV test blocks before it are cash. That keeps each path's
    sign but removes 2022 from item 1's CPCV condition. The PBO and SPA use the walk-forward span (M), and the shared
    cash days lower their power without a direction of bias.
  - The family D report gives the cash share of decision times in the walk-forward and in each CPCV path.
- The no-refit twin of a family D configuration freezes its score model only. Its f is the same walk-forward f.
- H and lab-v5. f comes from the finalist's final model: per coin, fit_fold with the cutoff DEV_END minus 30 days in
  place of the refit and the same lookback (family C's declaration), applied without refit.
- Disclosed: the family C finalist is a development result (H unread, its finalist lock unsigned). Its use here is the
  plan's "Its output also filters and sizes A, B and D", fixed before family D's first D read. A family D result
  neither validates the forecast nor depends on its H read. The EWMA benchmark (fit-free, full coverage) was offered
  and not chosen.

A6.3 THE BOOK-LEVEL BAND. For a family D configuration with b > 0, under either weight rule. A band b > 0 requires exit
E1.
- At a decision time T, w_new is the target of the configuration's weight rule. w_prev is the target taken at the
  decision T - h, whose tranche exits at T + 10m, the 5m open where T's tranche enters.
- w_prev is defined only when the decision at T - h lies in the same test block and was not cash, and its ranked coins
  (a zero-weight median coin included) are T's ranked coins.
- If w_prev is defined and max over i of abs(w_new_i - w_prev_i) <= b, the decision at T takes w_prev. Otherwise it
  takes w_new. With w_prev taken, the opening tranche equals the expiring one on every coin, and A1.1's netting trades
  nothing.
- One decision per time, never a subset of coins, as in the book-level band of scripts/research/exposure-sim.ts (there
  against the held position, here against the expiring tranche). Either way each target keeps sum abs(w) = 1 and
  sum w = 0. The book of h / interval stacked tranches keeps sum w = 0, and its net gross is at most 1 (below 1 when a
  coin's stacked tranches differ in sign, or after a cash decision).
- The band's state lives within one test block (a walk-forward month or a CPCV test group). The frozen walk_forward
  calls _make_tranches once per month, and adjacent groups of a CPCV path come from different splits. A decision whose
  T - h lies before the block's first decision time takes w_new. Disclosed: the first h / interval decisions of each
  block are unbanded, 8 of about 720 at 1h/8h, 2 of about 180 at 4h/8h and 6 of about 180 at 4h/24h each month.
- b is in units of weight on the sum abs(w) = 1 book. The registered values are 0.045 and 0.09, which are 0.25 and 0.5
  of the largest A1.4 weight on 10 coins (4.5 / 25 = 0.18). b = 0 is no band.
- Disclosed: 0.045 and 0.09 are the band fractions 0.25 and 0.5 of the exposure-gates.ts grid. On that path's
  linearRank book a positive band was selected in 11 of 12 windows (0.5 in all six at 1h, 0.25 or 0.5 in five of six at
  4h), on a slow realised-volatility factor. The b = 0 selections in 11 of 12 windows (exposure-gates.ts and
  exposure-sim.ts) were the tanh path's per-symbol band, a different rule. Here nothing is selected: each band value is
  its own configuration and trial.

A6.4 CODE BINDING. It extends A5.1's extension-node rule to these dimensions.
- The extension nodes may gain a branch selected by weight rule "inv_vol" or a band b > 0, which no C4 configuration
  and no configuration already run on D reaches:
  - RunConfig and run_config_from_raw: two fields, with the defaults "rank" and 0;
  - run_wf and run_tripwire: each builds the RunConfig with the two fields and supplies f to decision_samples, and
    run_wf also runs the parity check once per run and writes the family's decision-level record (one row per decision
    time and coin in the walk-forward and in every CPCV test block, with its sha256 in the receipt);
  - decision_samples: the f column, never a feature;
  - _make_tranches: calling the new module.
  walk_forward, restrict_to_d and cpcv_path_daily pass the column through unchanged. The node guard is re-pinned in
  the family commit.
- New module r4/family_d.py holds the full-grid f, the canonical digest, the inv_vol weights, the band and the family's
  registry. Its tests cover:
  - the weights: sum abs(w) = 1 and sum w = 0 at 1e-12, the sides from the centred ranks, cash below 6 coins, on all
    ties and on a non-positive f;
  - the band on hand cases: the repeat, the coin-set change, the block start, and cash at T - h;
  - that the defaults reproduce rank_weights bit for bit, and that banded fills net to zero in book.netted_costs;
  - the digest against a test vector;
  - causality.assert_future_invariant on f with each input's closing rule (A5.1): every coin's 5m bars and 5m premium
    index at 5 minutes, settlements at 0.
- A5.1's Opus diff review and its eight-run reproduction check bind the family D digest before its first D outcome. The
  reproduction set already holds a D-book run (noise_36_d_C4_s1), which the defaults must reproduce. Disclosed: the
  reproduction exercises only the defaults, and the inv_vol and band branches rest on the tests above.
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
