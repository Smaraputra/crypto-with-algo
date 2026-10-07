/**
 * BROAD TREND PHASE: the five legends trend rules on a survivorship-free universe, pre-registered,
 * parameters unchanged, one run each.
 *
 * Why: the legends phase (trend-sim.ts header) closed every family on ten 2026 survivors. TF4, C3 and TF1
 * passed every trend gate except gate 8 there, and its text reserves exactly one way back: "Only a new
 * universe (survivorship-free, materially broader) reopens it, under a new pre-registration." This is that
 * pre-registration. Plan: ~/.claude/plans/lets-design-the-combination-wondrous-flurry.md, approved by the
 * user on 2026-10-07 together with the decisions marked (user) below.
 *
 * Reviewed adversarially by agy on 2026-10-07 before the lock; the accepted findings are folded into the
 * text below and the two rejected ones are recorded at the end with the reason.
 *
 * STATUS: LOCKED once committed as the first commit on `research/universe-trend`, before any code that
 * reads or computes returns. Nothing below may change; a change means a new pre-registration and new
 * trials. Choices the text leaves open are recorded as implementation notes at build time, before any run,
 * and none may change a rule.
 *
 * TRIALS AND LEDGER
 *
 * - Five trials, never extended: TF1, TF2, TF3, TF4, C3, exactly as defined in the trend-sim.ts header
 *   (TREND SET and C3), every parameter unchanged (user). Benchmarks and sensitivities are not trials.
 * - Program ledger: 1,724 after the legends phase; this phase adds 5, for 1,729.
 * - What a result means. A rule that passes all nine gates gets the lockbox read once, under this same
 *   container; passing that, it becomes a candidate for a forward-only paper record that needs its own
 *   pre-registration, power calculation and read rule first (2026-10-01 review). Nothing is built on it
 *   before then. A rule that fails is closed on Binance USDT-M perpetuals: no other top-N, volume window,
 *   eligibility age or cost tier reopens it, because varying those after a result is a search. Only a
 *   different venue or asset class, under a new pre-registration, reopens it.
 *
 * DATA
 *
 * - Prices: Binance USDT-M perpetual daily klines from data.binance.vision (monthly files, with daily files
 *   filling the days monthly files omit), open as the fill price, close as the signal and mark price. No
 *   spot proxy. The archive's first monthly file is 2020-01 for every contract.
 * - Funding: the archive's fundingRate settlements only, at each contract's own settlement interval. No
 *   snapshot fallback. Every settlement due on a held day per the archive's own interval must exist; a
 *   missing one stops the run before any return is computed, and its resolution is recorded.
 * - Contract metadata: one snapshot of https://fapi.binance.com/fapi/v1/exchangeInfo (it lists delisted
 *   contracts as SETTLING), stored with its sha256 beside the universe source.
 * - Ingested into production Mongo (perpcandles, fundingsettlements; neither has a live reader), exported
 *   to a fresh directory, every file hashed in the manifest. The universe file records the export hash and
 *   its own sha256.
 * - Lockbox: nothing from 2026-07-01 onward is read.
 *
 * CANDIDATES AND CLASSES (mechanical; verified on 2026-10-07: 1,056 folders under
 * data/futures/um/monthly/klines/, 895 named <TICKER>USDT, 53 dated quarterlies, 40 USDC-quoted, 63 BUSD-,
 * USD1-, U- or BTC-quoted or USDTSETTLED, 5 non-ASCII)
 *
 * - Candidate folders are the union of the monthly and daily klines listings. A folder is a candidate only
 *   if its name matches ^[A-Z0-9]+USDT(SETTLED)*$; every other folder is excluded and counted.
 * - A folder's base ticker is its name without trailing SETTLED repeats. An XXXUSDTSETTLED folder holds an
 *   earlier contract of a relisted ticker and is a separate contract with the base ticker's class.
 * - Class from exchangeInfo when it lists the base ticker: included only if contractType is PERPETUAL,
 *   underlyingType is COIN, quoteAsset is USDT and baseAsset is not a stable or gold-backed asset (USDC,
 *   USDT, FDUSD, TUSD, BUSD, USDP, DAI, USDE, PYUSD, USD1, RLUSD, EUR, EURI, PAXG, XAUT). TradFi
 *   (TRADIFI_PERPETUAL), index and pre-market contracts are excluded.
 * - Base tickers absent from exchangeInfo (31 on 2026-10-07): indices excluded (BLUEBIRDUSDT,
 *   FOOTBALLUSDT, DOTECOUSDT); crypto included (1000BTTCUSDT, AERGOUSDT, AKROUSDT, ANCUSDT, ANTUSDT,
 *   AUDIOUSDT, BDXNUSDT, BTCSTUSDT, BTSUSDT, BTTUSDT, BZRXUSDT, COCOSUSDT, DODOUSDT, EOSUSDT, FRONTUSDT,
 *   GALUSDT, HNTUSDT, KEEPUSDT, LENDUSDT, LUNAUSDT, MATICUSDT, MBLUSDT, NUUSDT, RNDRUSDT, SRMUSDT,
 *   SXPUSDT, TOMOUSDT, YFIIUSDT). These are every absent ticker in the 2026-10-07 listing, so no
 *   delisted contract is lost to the snapshot's date; a folder that appears later is excluded and listed.
 * - Asset key: the base ticker without USDT and without a leading multiplier prefix (1000000, 1000, 1M).
 *   When two eligible contracts share an asset key at a ranking close, only the higher-volume one is
 *   ranked. Migrations and redenominations under a new ticker (MATIC to POL, RNDR to RENDER) are different
 *   contracts; there is no hand-made map.
 *
 * CONTRACTS
 *
 * - A contract is a run of one folder's daily bars. A gap of more than 7 missing days ends it; the bars
 *   after the gap start a new contract with its own age. A gap of 1 to 7 missing days ends it only when the
 *   close after the gap is more than 5 times, or less than one fifth of, the close before it (a
 *   redenomination); a move between consecutive days never ends a contract, so a genuine crash (LUNA,
 *   May 2022) is booked in full. Every consecutive-day close ratio above 5 or below one fifth is listed in
 *   the universe report before any rule runs; one that is a redenomination of the same ticker is a data
 *   defect that stops the run, like a missing settlement, and is resolved as a gap-jump break and recorded.
 * - Inside a contract, missing days of a gap that does not end it carry the last close (open = close =
 *   last close). Nothing fills on a carried day: an order due then fills at the next real bar's open, and
 *   no funding is charged on a carried day. The move across the gap is booked when data resumes.
 * - A contract's end before 2026-06-30 is a delisting: a member holding it is closed at its last close
 *   moved 2% against the position (the delisting haircut, in place of slippage), plus the taker fee.
 *
 * UNIVERSE (user: point-in-time top 50, monthly, 365 days of history, delisted included)
 *
 * - Ranking closes: 00:00 UTC on the 1st of each month. At a ranking close C a contract is eligible when it
 *   is a candidate, has at least 366 daily bars closed by C (so every lookback of every rule, the longest
 *   being 365 days, is defined at entry), and has a bar closing at C.
 * - Rank: the median daily quote volume of its bars among the 30 days closing by C (at least 20 bars
 *   present, otherwise not ranked); ties broken by ticker. Nothing closing after C is read, and a contract
 *   that ends days after C is still selected at C.
 * - Members for the month after C: the top min(50, eligible). They join at the open after C and stay
 *   until the next ranking close or their delisting, whichever comes first.
 * - Sample: from the first ranking close with at least 20 eligible contracts (2021-03-01 on the 2026-10-07
 *   exchangeInfo count: 3 eligible at 2021-01-01, 10 at 2021-02-01, 23 at 2021-03-01) to 2026-06-30.
 *   If that close is later than 2021-07-01, gate 1 fails by construction and is recorded as such.
 *
 * C3 BASKET
 *
 * - C3's index has its own point-in-time membership: the same ranking with an eligibility of at least 30
 *   bars instead of 366, the top min(50, eligible), from the 2020-02-01 ranking close. The index chain-links
 *   the equal-weighted daily close-to-close return of its members with closes on both days, and a member
 *   whose contract ends contributes the 2% delisting haircut as its return on the day after its last bar,
 *   so the index pays every failure the portfolio pays. Its state is
 *   C3's rule (28-day return in the top third of its trailing 365-day history, 5-day hold, re-check at the
 *   end of a hold) and is shared by every sleeve. Holdings are the universe members above.
 *
 * PORTFOLIO
 *
 * - Each member is a sleeve. At every ranking close capital is split equally across that month's members
 *   (re-equalisation happens only there, so it is also the only time sleeves join or leave). A sleeve
 *   returns to its rule's TARGET weight (the target of its last rule order, never its drifted weight) on
 *   its new capital, by an order at the next open that pays the usual costs (trend-sim.ts note 9).
 * - A member that leaves at a ranking close trades to zero at the next open. Its rule state is discarded;
 *   if it rejoins later its first decision is forced, as at a listing.
 * - Capital released by a delisting is held as cash at 0% until the next ranking close. Sleeve capital plus
 *   cash equals portfolio equity on every day (asserted).
 * - A rule's signal is computed on the contract's own full history, not only on member days. A signal that
 *   is not yet defined holds nothing.
 * - The always-long twin T+ is the rule with its signal forced to fully long wherever the rule's signal is
 *   defined (same volatility estimate, sizing, cap, schedule and band) and holds nothing where it is not.
 *   TF3+ holds each member from its join; C3+ holds every member continuously.
 *
 * COSTS
 *
 * - Taker fee 0.05% on every unit of traded notional (standard profile).
 * - Slippage per side by the member's rank at the last ranking close: ranks 1 to 10 at 2 bps, 11 to 25 at
 *   5 bps, 26 to 50 at 10 bps. A leaving member's exit is charged 10 bps. A delisting exit uses the 2%
 *   haircut instead.
 *
 * GATES (all must pass; statistics as in trend-sim.ts implementation note 12 unless stated)
 *
 * 1. Sample: at least 1,825 portfolio days from the first day any member holds a defined signal.
 * 2. Expectancy: annualised Sharpe of daily portfolio returns, block-bootstrap 95% CI low > 0 (circular
 *    blocks of 60 days, 2,000 draws, seed 42; 20 and 120 reported).
 * 3. Beats its twin: alpha (365 x the intercept of OLS of T's daily returns on T+'s) block-bootstrap CI
 *    low > 0. Reported beside it, because the twin is weak in a universe of fading alts: alpha against
 *    BTCUSDT perp held at 1x with funding, and against a constant-gross equal-weight long of the members.
 * 4. Timing: two nulls, and BOTH must give p < 0.05. Each takes 200 draws (seed 7); each draw takes ONE
 *    shift k, uniform on [365, S - 365] days where S is the number of days from 2020-01-01 to 2026-06-30;
 *    sizes stay on their true dates; the rule is re-run and its alpha taken against the unshifted twin;
 *    one-sided p = (1 + draws with alpha at or above the observed) / 201.
 *    (a) Wrapped: every contract's signal path is shifted circularly by k modulo its own length in bars
 *        (C3: its shared state path by k modulo the index length). Exposure is kept, but a contract younger
 *        than k is shifted out of calendar alignment with the others; the share of member-days so affected
 *        is reported.
 *    (b) Aligned: the signal on day d is the contract's signal on day d - k on one calendar that wraps from
 *        2026-06-30 back to 2020-01-01 (C3: its state likewise); where that day lies outside the contract's
 *        life the shifted rule holds nothing. Cross-asset alignment is kept exactly, at the cost of exposure.
 *    Each null leans anti-conservative in a different way, so the gate takes the larger p. Reported before
 *    the run, not gated: each null's rejection rate at 0.05 on 50 synthetic universes in which every
 *    contract's daily returns are permuted (no timing exists), seed 11.
 * 5. Cohorts: alpha point estimate > 0 after dropping, one at a time: each listing-year cohort (year of the
 *    contract's first bar; a cohort under 10% of member-days is merged into the next older one, the oldest
 *    into the next younger); the legends ten (BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK); BTC and
 *    ETH together; and the five contracts with the largest summed daily contribution to the rule's return
 *    minus beta times the twin's. C3's state keeps reading its full basket.
 * 6. Years: alpha positive in at least 60% of 2021 (from the sample start) to 2025; 2026 reported, not
 *    counted.
 * 7. Stress: alpha point estimate > 0 at 1.5x fees, 2x every slippage tier and a 4% delisting haircut.
 *    Reported: a 5% haircut.
 * 8. Trials (user: N = 16, the eleven legends trials plus these five): deflated Sharpe probability >= 0.95.
 *    SR* = sqrt(V) x ((1 - g) x InvPhi(1 - 1/N) + g x InvPhi(1 - 1/(N e))), g the Euler-Mascheroni
 *    constant. Every quantity is per period (daily), so the null floor is 1/(T - 1) with T the sample's
 *    portfolio days; annualised figures (x sqrt(365)) are reported only. V = the larger of the sample
 *    variance of this phase's five per-period Sharpes (four degrees of freedom, hence the floor) and that
 *    floor. The legends Sharpes do not enter V: another universe and another length. The probabilistic
 *    Sharpe uses each trial's own skewness and kurtosis (deflated-sharpe.ts). Reported, not gated: the
 *    same at the program count 1,729.
 * 9. Ex-2021: alpha point estimate > 0 over 2022-01-01 to 2026-06-30 (the legends CONSISTENCY window).
 * Reported, not gated: beta beside every alpha, long and short legs, max drawdown, turnover, funding paid,
 * gross quantiles, members per month, every delisting exit and its PnL, the one-bar delay, the 20 and 120
 * day blocks.
 *
 * POWER (before any data is ingested)
 *
 * At T = 1,948 days (2021-03-01 to 2026-06-30) the sampling standard error of an annualised Sharpe is
 * about sqrt(365 / 1,948) = 0.43. With V at the null floor (where the cross-trial spread equals that
 * sampling error) the expected maximum at N = 16 is about 0.43 x 1.80 = 0.78 annualised, and a deflated
 * probability of 0.95 needs an annualised Sharpe of about 0.78 + 1.645 x 0.43 = 1.49, before skewness and
 * kurtosis. If the five Sharpes spread like the legends five (sd 0.46) the bar is about 1.52. On the ten
 * survivors the best were C3 1.36 and TF4 1.31.
 *
 * PREDICTIONS (written before any data is ingested)
 *
 * | rule | annualised Sharpe | alpha against twin | expected first failing gates |
 * | --- | --- | --- | --- |
 * | TF1 | +0.2 to +0.6 | CI spans zero | 8, then 3 |
 * | TF2 | 0.0 to +0.4 | CI spans zero | 2, 3, 8 |
 * | TF3 | +0.3 to +0.7 | positive point estimate (the twin holds fading alts) | 8, 4 |
 * | TF4 | +0.5 to +0.9 | positive, CI may clear zero | 8 |
 * | C3 | +0.4 to +0.9 | under half the legends +40.3% | 8, 9 |
 *
 * Expected verdict: nothing passes gate 8. Survivorship and 2021 carried the legends near misses.
 *
 * NOTE ON THE LEGENDS RECORD (not a verdict change): the legends timing null shifted every symbol
 * independently. For C3, whose state is one shared path, that diversifies the null and makes its timing p
 * of 0.005 anti-conservative. The legends phase failed every trial at gate 8 regardless.
 *
 * REVIEW FINDINGS NOT ADOPTED (agy, 2026-10-07)
 *
 * - "The 1/(T - 1) floor is off by a factor of 365": no. Gate 8 is computed entirely on per-period Sharpes,
 *   where the sampling variance of a Sharpe estimate is 1/(T - 1); annualising both sides changes nothing.
 * - "V should be the variance of all sixteen trials' Sharpes": no. The eleven legends Sharpes were measured
 *   on another universe over another length, so their spread is not this sample's null dispersion. N = 16
 *   counts the lineage of tries; V measures this sample, bounded below by the floor.
 */
export {};
