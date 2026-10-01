/**
 * FUNDING CARRY: long spot, short USDT-M perpetual, collecting funding.
 *
 * PRE-REGISTRATION, 2026-10-02, committed before any simulation code.
 * Decided by the user on 2026-10-01 after the program review: the one kind of
 * return the program never measured is a structural transfer (longs paying
 * shorts), not a prediction of direction. Every directional axis on this
 * dataset has already failed under a pre-registered criterion.
 *
 * HYPOTHESIS. Holding one unit of notional long spot against one unit short
 * perp on each of the ten signal symbols earns the funding the perp's longs
 * pay, net of fees, slippage and basis drift, positively and stably enough
 * over 2023-01-01 to 2026-06-30 to beat a USDT savings yield.
 *
 * DATA. Per-settlement funding from the `funding` dataset kind (the
 * `FundingSettlement` collection, backfilled 2026-10-01: 69,945 settlements,
 * the 8h grid holding in 69 of 70 symbol-years and SOLUSDT 2022 on 2h and 4h);
 * spot 1h candles (`candles`); perp 1h klines (`perp`). Each symbol's bars are
 * the timestamps its spot and perp series share. Lockbox applied: nothing
 * from 2026-07-01 is read.
 *
 * POSITION. Per symbol a weight w in {0, 1}: w = 1 is one unit of notional
 * long spot and one unit short perp, re-marked to constant notional each bar
 * (the hedge drift that rebalancing would cost is not modelled and is small on
 * a hedged pair). Spot is 1x: 2x and 3x need USDT borrow-rate history the
 * repository does not have, and are DEFERRED rather than modelled on an
 * assumed rate, which could decide the result.
 *
 * RETURN per unit notional over bar t, decided at its close T_t:
 *   w_t x [ (S_t+1 / S_t - 1) - (P_t+1 / P_t - 1) ]          basis drift
 *   + w_t x sum of rate_s over settlements T_t < s <= T_t+1     funding received
 *   - c x |w_t - w_t-1|                                        turnover cost
 * A settlement at exactly T_t belongs to the bar before, so entering at T_t
 * does not collect it and an exit decided at T_t+1 = s does. Signals read
 * only settlements with s <= T_t.
 *
 * COSTS. c per unit turnover = spot taker 0.10% + perp taker 0.05% + 3 bps
 * study slippage on each leg = 0.21%, so 0.42% a round trip. Spot is the
 * published VIP 0 schedule (0.10% maker and taker); THE USER CONFIRMS IT ON
 * THEIR OWN FEE PAGE before the result is read, as perp fees were confirmed on
 * 2026-09-27. Reported, never selected on: maker on both legs (0.12% a side,
 * no slippage) and spot with BNB (0.075%).
 *
 * RULES, trials 7.
 *   R0  always on: w = 1 throughout. The benchmark, nothing selected.
 *   R1  hysteresis on trailing funding. F_L = (sum of rates settled in the last
 *       L days) x 365 / L, annualised in calendar time so a symbol settling
 *       every 2h or 4h is counted correctly. Enter when F_L > E, exit when
 *       F_L < 0. Grid L in {3, 7} days, E in {5%, 10%, 20%} a year: 6 cells.
 *
 * WALK-FORWARD. Seven test windows of six months from 2023-01-01 to
 * 2026-06-30, each trained on the twelve months before it. Every window starts
 * flat and ends flat for both rules, round trips charged. R1's cell is the one
 * with the best training-window net return per unit notional.
 *
 * STATISTICS. The book's daily return is the mean over the ten symbols of
 * each symbol's return per unit notional (an idle symbol earns 0), annualised
 * by 365. Stationary block bootstrap of daily returns, 2,000 draws, seed 42,
 * mean block max(mean R1 episode in days, 20); 10 and 40 days as sensitivity.
 *
 * KILL CRITERION. The carry hypothesis is rejected if ANY of:
 *   (a) the pooled annualised net return per unit notional has CI low <= 0;
 *   (b) its point estimate is below H = 5% a year, a USDT savings yield taken
 *       as an assumption at the level of Binance Simple Earn's flexible USDT
 *       product over 2024 to 2026 (stated, not measured here);
 *   (c) more than one of the calendar periods 2023, 2024, 2025, 2026H1 is
 *       negative.
 * R1 counts as a timing finding only if it also beats R0 (paired annualised
 * difference with CI low > 0) AND a timing null that circularly shifts each
 * symbol's weight path against its returns and settlements, 200 shifts,
 * gives p < 0.05. The null keeps each path's duty cycle and switch count, so
 * its costs are R1's own.
 *
 * Reported, never gates: per-symbol results, the drop-one-symbol jackknife,
 * the two cost rows above, a per-symbol feasibility table at 100, 500 and
 * 1,000 USDT of capital (spot and perp minimum notional, perp lot rounding),
 * and a LEVERAGE TABLE for the perp leg at 1x, 3x, 10x, 20x and 50x. Leverage
 * cannot change the return per unit notional, which is why the verdict is
 * judged there; it changes return on capital (notional return / (1 + 1/L))
 * and liquidation risk. Margin is topped up from the spot leg once a day at
 * 00:00 UTC; between top-ups the short is liquidated if a 1h perp HIGH rises
 * past the top-up reference by 1/L - 0.5% (an assumed maintenance margin),
 * costing an assumed 1.0% of notional plus a re-entry round trip. Per leverage:
 * return on capital, liquidation count, cost, worst drawdown and worst adverse
 * move against the liquidation distance.
 *
 * PREDICTION, with its arithmetic. Funding settled on 1h snapshots from
 * 2021-10 to 2026-06 averaged, a year: BTC 7.3%, ETH 6.5%, LINK 8.6%,
 * DOGE 8.1%, ADA 6.3%, XRP 6.2%, AVAX 3.6%, SOL 0.2%, DOT -0.4%, BNB -5.8%, an
 * equal-weight 4.1%. The test span is later and weaker: from 2025 the highest
 * settled rate on most symbols is the 0.01% base, and the share settling at it
 * fell to 2 to 3% on BTC and ETH in 2026H1. Costs take about 0.84% a year
 * (one round trip per six-month window). Predicted R0: +2% to +3.5% a year per
 * unit notional, CI low plausibly above zero, BELOW the 5% hurdle, so the kill
 * criterion fires on (b). Predicted R1: +2% to +4%, avoiding BNB, DOT and SOL's
 * negative stretches but earning nothing while idle, also below the hurdle,
 * with timing p against R0 above 0.05.
 *
 * The lockbox is read once, only if the criterion is passed.
 */
export {};
