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
 *
 * AMENDMENT 1 (2026-10-07, before any data was ingested or any return computed)
 *
 * Reading the archive's folder contents while building the data tooling showed that three statements above
 * rest on a wrong picture of the archive. Each change below supersedes the bullets it names; nothing else
 * changes, and the trials, gates and predictions stand.
 *
 * - SETTLED folders are excluded. Verified 2026-10-07: every XXXUSDT(SETTLED)+ folder (16) and
 *   ICPUSDT_SETTLED is either a settlement stub (one or two daily rows, almost all with zero volume) or a
 *   month-for-month copy of rows its base ticker already holds (TLMUSDTSETTLED for 2022-01 to 2023-03,
 *   ICPUSDT_SETTLED for 2022-01 to 2022-09, identical rows). None holds an earlier contract, so including
 *   them could only count a contract twice. A folder is therefore a candidate only if its name matches
 *   ^[A-Z0-9]+USDT$ (single-character tickers such as AUSDT included, as the original pattern allowed).
 *   Supersedes the CANDIDATES bullets on SETTLED folders and the "base ticker" bullet's SETTLED clause.
 * - A daily bar with zero traded volume counts as a missing day for every rule: contract segmentation
 *   (a run of more than 7 such or absent days ends a contract), eligibility's bar count, the ranking median
 *   (it is not a bar), fills, marks and funding. The archive prints flat zero-volume bars while a contract is
 *   halted or settling (CVXUSDT for all of 2025-07, at a constant 2.374), so without this a halt would never
 *   end a contract and a relisting jump would be booked as one day's return. Supersedes the CONTRACTS
 *   bullets' notion of a missing day.
 * - Same-asset ties: when two contracts sharing an asset key have equal median volume at a ranking close,
 *   the ticker that sorts first is ranked.
 * - "The archive's first monthly file is 2020-01 for every contract" means the archive begins in 2020-01;
 *   a contract listed later begins at its own first file (LUNAUSDT 2021-01). No rule depended on it.
 */

import { createHash } from 'node:crypto';

import type { PerpCandleRow } from './dataset-format';
import { TREND_COST, type BroadCost, type TrendCost } from './trend-sim';
import { assetKey } from './universe-source';

/*
 * IMPLEMENTATION NOTES (build time, before any run; none changes a rule). The header above is untouched.
 *
 * A3, the point-in-time universe. Pure functions over exported perp rows; no returns, signals or statistics.
 *
 * - Volume. "Zero volume" is the bar's base-asset volume `v` being 0 (the archive's flat halted bars).
 *   A bar is traded only when v > 0. The ranking median still reads the quote volume `qv` of traded bars.
 * - Sample end. A contract "ends before 2026-06-30" when its last traded bar's day start is earlier than
 *   2026-06-30 00:00 UTC; a last bar on 2026-06-30 itself is not a delisting.
 * - Segment boundaries. A contract that stops trading and resumes after more than 7 missing days, or after
 *   1 to 7 missing days across a close ratio beyond 5x or under 1/5, ends at its last traded bar before the
 *   stop. A non-final contract of a symbol therefore also reports an end day (contractEnded).
 * - Eligible versus ranked. The start rule counts eligible contracts (bar count and a bar closing at C),
 *   before the asset dedupe, as the header's counts did. A contract with fewer than 20 volume bars in its
 *   30 days is eligible but not ranked, so members are the top min(topN, ranked), which never exceeds
 *   min(topN, eligible). Both counts are recorded per month.
 * - Median of an even count of volumes is the mean of the two middle values.
 * - Ties between equal volumes are broken by plain code-unit string order of the symbol, ascending, then by
 *   contract id (two segments of one symbol cannot both be eligible at one C, so the id never decides).
 * - Month closes. Ranking closes run over the 1st of each month with from <= C < to. `to` is the exclusive
 *   end of the sample (2026-07-01 as a day start, so the last close is 2026-06-01 and its membership is valid
 *   until 2026-07-01). A close at `to` would read only bars through 2026-06-30 but would hold no sample day.
 * - The C3 basket has no start threshold: it starts at its `from` close, whatever the eligible count.
 *
 * A4, the container: trend-sim.ts runTrend with SimOptions.broad, trend-signals.ts broadPaths,
 * pointInTimeBasket and twinOfBroad, and trend-sim.ts timingNull's 'wrapped' and 'aligned' modes. All opt-in:
 * without `broad` and a null mode the legends container is byte-identical (trend-golden.test.ts).
 *
 * - Ranking closes are the 00:00 UTC closes on the 1st. A broad run starts at one. Membership spans run from one
 *   ranking close to another, sorted and disjoint; the members of [C, next C) are the inputs whose span covers C.
 *   An input's listing day is not read in broad mode.
 * - Legends mode refuses an input carrying membership, an end day or a carried day rather than ignore it.
 * - Costs. `cost.slippage` is not read in broad mode. A fill pays the taker fee plus the tier of the member's rank in
 *   the span that kept it at the last ranking close; a leaving member's exit pays the fee plus 10 bps; a delisting
 *   exit pays no slippage.
 * - Leaving. At C a sleeve that is not a member gets capital 0 (its capital enters the split), and its pending
 *   orders, including a rule order not yet filled under the one-bar delay, are replaced by one order to 0 at the next
 *   open. It makes no decision while leaving. After that order fills, its capital (the overnight PnL minus the cost,
 *   possibly negative) moves to cash and its state resets. A sleeve selected again before its exit has filled stops
 *   the run (it cannot happen with carried gaps of at most 7 days and a delay of at most one bar).
 * - A member whose contract's last bar closes at or before C is selected (the ranking cannot see the future) but
 *   never trades: its equal share is held as cash at 0% until the next ranking close.
 * - Delisting. On the end day, after the funding and the mark, a position is closed at close x (1 - h) for a long or
 *   close x (1 + h) for a short; the fee is the taker fee on |qty| x that exit price. The haircut (|qty| x close x h)
 *   and the fee are booked as cost, not in the long or short leg; the exit notional counts as turnover. Funding for
 *   the settlements in (end day, end day + 1 day] is charged first, the position being held to the close.
 * - Carried days. No price PnL, no fill and no funding; the mark is the carried close, which must equal the last real
 *   close (asserted on input). When several orders are due at the next real open, the most recently decided fills.
 * - Cash and the invariant are checked after every day and after every ranking close.
 * - `run.startDay` holds each input's first join; an input never joined is left out.
 * - Defined signals: TF1 from bar 60, TF2 from 365, TF3 from 199, TF4 from 359 (each with a finite size); C3 from
 *   basket index position 28 + 365. broadPaths sets the signal to 0 where it is not defined, so a timing null that
 *   moves an undefined stretch onto member days holds nothing there.
 * - C3 basket. The index is 1 on the first basket day (the legends convention: no return that day). A member with a
 *   carried close on either day is skipped that day; a day with no contributor keeps the level. The haircut is
 *   charged on the day after the end day to a contract that was a basket member ON its end day: the header's "so
 *   the index pays every failure the portfolio pays", and the portfolio pays when it holds a contract on its last
 *   day, whether or not the next ranking keeps it.
 * - Timing nulls. k = 365 + floor(u x (S - 729)) with one uniform u per draw (seed 7); S = 2,373 for 2020-01-01 to
 *   2026-06-30. 'aligned' stops on an input bar outside the calendar. In 'wrapped', C3's misaligned share is 1 when
 *   the basket index is no longer than k, else 0. A member-day is a day of [from, to) that a membership span covers
 *   while the contract has a bar.
 *
 * A5, the harness: broad-inputs.ts (inputs), broad-gates.ts (the nine gates), broad-harness.ts (runBroadStudy and the
 * CLI), the schema v2 report (report-schema.ts BroadTrendReportSchema), broad-dsr.ts and legends-dsr.ts's options
 * (gate 8). Recorded before any run; none changes a rule.
 *
 * - Inputs. One TrendSymbolInput per contract with `symbol` = the contract id (SYMBOL#n), so sleeves, paths,
 *   contributions and drops are per contract. The sleeves are the universe members; the C3 basket reads every basket
 *   member, and a contract that is only a basket member never trades, so its funding is not read. Each contract is
 *   re-segmented from the export and must equal the universe file's metadata for it, or nothing runs. The CLI also
 *   requires the universe file's parameters to be the pre-registered ones.
 * - Sample. The run spans the universe's start close to its end (2026-07-01). Gate 1 counts, and every gated or reported
 *   statistic uses, the days from the first day d on which some member, with bars on d - 1 day and d, has its rule
 *   defined at the bar of d - 1 day (the close whose decision sets day d's holding). With 366-bar eligibility TF1 to TF4
 *   are defined at every member's first close; C3 from basket position 393 (the decision of 2021-02-28 when the basket
 *   starts on 2020-02-01).
 * - Funding coverage. A contract's settlements are those with t in (first bar day, last bar day + 1 day]. A row's
 *   interval is its spacing to the next (settlementSpacingReport's convention): a longer gap is missing settlements at
 *   that spacing, and the grid extends at the first row's interval before it and the last row's after it. Checked days:
 *   member days with a real (non-carried) bar, plus the day a membership ends while the contract trades (a leaver under
 *   the one-bar delay holds through it); BTCUSDT, the reported benchmark, on every real sample day. Not due: anything at
 *   or after 2026-07-01 00:00 (the lockbox, so the last sample day's 00:00 settlement is neither required nor charged),
 *   a contract's first day before its first settlement (it lists inside the day; never a member day under 366-bar
 *   eligibility), and a delisted contract's last day after its last settlement (it stops inside the day). A row without
 *   a stated interval whose stretch touches a checked day cannot be verified and stops the run like a missing one. Every
 *   missing settlement is listed in one error before any return. A halt that starts inside a traded day (that day's
 *   later settlements absent) stops the run: the header grants no exemption, so its resolution is recorded at run time.
 * - Calendar. Every bar of every input must lie in 2020-01-01 to 2026-06-30 (the null calendar), or the run stops
 *   before any return.
 * - Gate 4. An undefined observed alpha runs no null and records p as null, so the gate fails (no draw is at or above a
 *   NaN, which would read as p = 1/201). 'aligned' reports a misaligned share of 0 (alignment is kept) and its exposure
 *   loss: the mean over draws of the share of member-days whose source day lies outside the contract's bars (C3:
 *   outside the basket's days), where the shifted rule holds nothing.
 * - Null size (gate 4, reported). One stream (seed 11) permutes, universe by universe and contract by contract in id
 *   order (Fisher-Yates), each contract's close-to-close returns on its real days among those days; prices are rebuilt
 *   from the first close with each open at the previous close; carried days, membership, funding and end days stay;
 *   C3's basket is rebuilt from the permuted closes. Each universe re-runs T, T+ and both nulls at seed 7 with the
 *   gate's draw count; a null rejects at p < 0.05, both when the larger p does. It runs before the rule's own run.
 * - Gate 5. Member-days are trend-sim.ts memberDays over the run. The merge repeats until no cohort is under 10% (strict)
 *   or one remains, taking the youngest cohort under 10% first; a merged cohort merges again while still under. The
 *   legends ten and BTC and ETH are chosen by asset key, so every contract of those assets is dropped. The top five
 *   rank contracts by the summed daily contribution (portfolio-equity units) of T minus beta x T+'s, beta the OLS beta of
 *   T on T+ over the sample, ties by contract id. A drop re-runs T and T+ without those sleeves (capital splits over the
 *   rest) with the paths unchanged, so C3's state reads the full basket; an empty drop re-runs the whole portfolio. If
 *   the merge leaves one cohort, dropping it drops every member, the alpha is undefined and the gate fails.
 * - Gate 6. A gated year with fewer than two sample days has no alpha and counts as not positive; the share is over the
 *   five years 2021 to 2025 always.
 * - Gate 7. 1.5x the taker fee and stressBroad (2x every tier, 2x the 10 bps leave slippage, a 4% haircut). The
 *   reported 5% case is the same stress with the haircut at 5%.
 * - Gate 9. The alpha over the sample days from 2022-01-01 to 2026-06-30 of the same run, not a fresh run from 2022.
 * - Benchmarks (gate 3, reported). BTC: the BTCUSDT contract that spans the sample, a member at rank 1 every month,
 *   signal and size 1, trading only at ranking closes back to 1x (so drifting between), broad costs and archive funding;
 *   unavailable when no BTCUSDT contract spans the sample. Members: every member at 1x of its sleeve, traded back to 1x
 *   at every close, capital split equally at ranking closes, so gross is constant outside cash and equal weight is
 *   restored monthly. Alpha and beta of T on each over the sample.
 * - Reported detail. Members per month are read at the close of each month's first day; a delisting's day contribution is
 *   the sleeve's PnL on its end day (haircut and fee included) over the equity at the previous close.
 * - Counts. The CLI runs 2,000 bootstrap draws, 200 null draws and 50 null-size universes; the core takes lower counts
 *   for tests only, and every report records the counts it used.
 * - Gate 8 (broad-dsr.ts). N = 16, the program count 1,729 beside, V = max(the five per-period Sharpes' sample variance,
 *   1/(T - 1)) with T the shortest of the five daily series, each trial's probabilistic Sharpe with its own length,
 *   skewness and kurtosis. The five reports must share one export hash and one universe sha256. A trial passes when its
 *   report reads 'pending-trials' and its deflated probability is at least 0.95. legends-dsr.ts's defaults are the
 *   legends rule, unchanged: a golden pins the default path and the record (2.405e-3, 1.520, C3 0.330, TF4 0.294) is
 *   reproduced from its own trial statistics (legends-dsr.test.ts).
 *
 * A6, the runs. Recorded while running, before any statistic of a run is read; none changes a rule.
 *
 * - A6-1 Funding intervals and resolutions (2026-10-08). The TF4 smoke run on export aa62c5a1cb51 stopped on 34
 *   flagged settlements before any return. Binance's REST funding history showed A5's reading of the archive's
 *   interval was wrong: a row's interval is the spacing BEFORE it (SOLUSDT's 2022-11-18 16:00 row states 8 after an
 *   08:00 row, LUNA2USDT's 2026-01-05 08:00 row states 4 after 04:00), so each gap is judged by the later row's
 *   interval, and a row without a stated interval leaves the gap before it unverified (reported at that row). This
 *   replaces A5's "spacing to the next". What the check still flags is resolved only through a recorded file
 *   (`--funding-resolutions`, its sha256 and counts in the report). `no-event`: Binance's REST history for the
 *   symbol confirms no settlement at that instant, so nothing is paid or charged. `unavailable`: neither the archive
 *   nor REST holds the contract's funding over a stretch (REST keeps only a relaunched ticker's newest contract); its
 *   settlements on checked days there are imputed on the 8h grid at the median of the other universe members'
 *   archive settlements at the same instant. Dropping such a contract instead would remove a failing contract from
 *   the universe, a bias toward passing. Every entry must match a flagged settlement or a member contract, or the run
 *   stops. `--funding-check-out` writes the flagged list as JSON for the evidence pass.
 */

export const DAY_MS = 86_400_000;
/** Header CONTRACTS: a gap of more than 7 missing days ends a contract. */
export const MAX_GAP_DAYS = 7;
/** Header CONTRACTS: a 1 to 7 day gap ends a contract when the close ratio is beyond 5 or under 1/5. */
export const GAP_JUMP_RATIO = 5;
/** Header UNIVERSE: the rank is the median over the 30 days closing by C, needing at least 20 bars. */
export const RANKING_WINDOW_DAYS = 30;
export const MIN_RANKING_BARS = 20;
/** Header CONTRACTS: delisting is an end before 2026-06-30. */
export const SAMPLE_END_MS = Date.UTC(2026, 5, 30);

export interface Contract {
  id: string;
  symbol: string;
  assetKey: string;
  /** Traded bars only (volume > 0), ascending by t, unique. */
  bars: PerpCandleRow[];
}

export function dayStartMs(isoDay: string): number {
  const ms = Date.parse(`${isoDay}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`Bad day "${isoDay}"`);
  return ms;
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Header AMENDMENT 1: a bar with zero volume is a missing day for every rule. Ascending, one bar per t. */
export function tradedDays(rows: PerpCandleRow[]): PerpCandleRow[] {
  const byTime = new Map<number, PerpCandleRow>();
  for (const row of rows) {
    if (row.v > 0) byTime.set(row.t, row);
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/**
 * Header CONTRACTS (with AMENDMENT 1): a run of more than 7 missing days (absent or zero-volume) ends a
 * contract; 1 to 7 missing days end it only when the close after is more than 5x, or under 1/5 of, the
 * close before; consecutive traded days never split. Ids are `SYMBOL#1`, `SYMBOL#2`, ... in time order.
 */
export function segmentContracts(symbol: string, rows: PerpCandleRow[]): Contract[] {
  const bars = tradedDays(rows);
  const key = assetKey(symbol);
  const contracts: Contract[] = [];
  let current: PerpCandleRow[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    contracts.push({ id: `${symbol}#${contracts.length + 1}`, symbol, assetKey: key, bars: current });
    current = [];
  };
  for (const bar of bars) {
    const previous = current[current.length - 1];
    if (previous) {
      const missing = Math.round((bar.t - previous.t) / DAY_MS) - 1;
      let split = missing > MAX_GAP_DAYS;
      if (!split && missing >= 1) {
        const ratio = bar.c / previous.c;
        split = ratio > GAP_JUMP_RATIO || ratio < 1 / GAP_JUMP_RATIO;
      }
      if (split) flush();
    }
    current.push(bar);
  }
  flush();
  return contracts;
}

/** Header CONTRACTS: "A contract's end before 2026-06-30 is a delisting." The last traded day, or null. */
export function contractEnded(contract: Contract, sampleEnd: number = SAMPLE_END_MS): number | null {
  const last = contract.bars[contract.bars.length - 1];
  if (!last) return null;
  return last.t < sampleEnd ? last.t : null;
}

/**
 * Header UNIVERSE: eligible at C when it has at least `minBars` (366) daily bars closed by C and a bar
 * closing at C. Only traded bars exist in a contract, so a bar at C - 1 day is a traded bar.
 */
export function eligibleAt(contract: Contract, closeMs: number, minBars: number = 366): boolean {
  let count = 0;
  let closesAtC = false;
  for (const bar of contract.bars) {
    if (bar.t + DAY_MS > closeMs) break;
    count++;
    if (bar.t === closeMs - DAY_MS) closesAtC = true;
  }
  return closesAtC && count >= minBars;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Header UNIVERSE: the median daily quote volume of the bars among the 30 days closing by C (at least 20
 * present, otherwise null). Nothing closing after C is read.
 */
export function rankingVolume(contract: Contract, closeMs: number): number | null {
  const volumes: number[] = [];
  for (const bar of contract.bars) {
    if (bar.t + DAY_MS > closeMs) break;
    if (bar.t >= closeMs - RANKING_WINDOW_DAYS * DAY_MS) volumes.push(bar.qv);
  }
  return volumes.length >= MIN_RANKING_BARS ? median(volumes) : null;
}

export interface RankedEntry {
  id: string;
  symbol: string;
  assetKey: string;
  rank: number;
  volume: number;
}

export interface RankOptions {
  minBars: number;
  topN: number;
}

export function eligibleContracts(contracts: Contract[], closeMs: number, minBars: number): Contract[] {
  return contracts.filter((c) => eligibleAt(c, closeMs, minBars));
}

function byVolumeThenTicker(
  a: { volume: number; symbol: string; id: string },
  b: { volume: number; symbol: string; id: string }
): number {
  if (a.volume !== b.volume) return b.volume - a.volume;
  if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Header UNIVERSE and CANDIDATES: eligible contracts ranked by median quote volume (ties by ticker), only
 * the higher-volume contract of an asset key ranked (equal volume: the ticker that sorts first, AMENDMENT 1),
 * top min(topN, ranked). Ranks start at 1.
 */
export function rankAt(contracts: Contract[], closeMs: number, options: RankOptions): RankedEntry[] {
  const measured: Array<{ contract: Contract; volume: number; symbol: string; id: string }> = [];
  for (const contract of eligibleContracts(contracts, closeMs, options.minBars)) {
    const volume = rankingVolume(contract, closeMs);
    if (volume !== null) measured.push({ contract, volume, symbol: contract.symbol, id: contract.id });
  }
  const best = new Map<string, (typeof measured)[number]>();
  for (const entry of measured) {
    const held = best.get(entry.contract.assetKey);
    if (!held || byVolumeThenTicker(entry, held) < 0) best.set(entry.contract.assetKey, entry);
  }
  return [...best.values()]
    .sort(byVolumeThenTicker)
    .slice(0, options.topN)
    .map((entry, index) => ({
      id: entry.id,
      symbol: entry.symbol,
      assetKey: entry.contract.assetKey,
      rank: index + 1,
      volume: entry.volume,
    }));
}

export interface MembershipOptions {
  /** First ranking close considered, a day string (the 1st of a month). */
  from: string;
  /** Exclusive end of the sample (see the implementation notes). */
  to: string;
  minBars: number;
  topN: number;
  /** The membership starts at the first close with at least this many eligible contracts. */
  minEligibleToStart: number;
}

export interface MonthMembership {
  close: string;
  closeMs: number;
  validFrom: string;
  validUntil: string;
  eligibleCount: number;
  rankedCount: number;
  members: RankedEntry[];
}

export interface Membership {
  options: MembershipOptions;
  /** Every ranking close from `from`, with its eligible count, including those before the start. */
  eligibleCounts: Array<{ close: string; eligible: number }>;
  /** The first close with enough eligible contracts, or null if none. */
  startClose: string | null;
  /** Header: a start later than 2021-07-01 makes gate 1 fail by construction. */
  startLaterThan20210701: boolean;
  months: MonthMembership[];
}

/** The 1st of each month with from <= C < to, as UTC day starts. */
export function monthCloses(from: string, to: string): number[] {
  const end = dayStartMs(to);
  const start = new Date(dayStartMs(from));
  const out: number[] = [];
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  for (;;) {
    const ms = Date.UTC(y, m, 1);
    if (ms >= end) break;
    if (ms >= dayStartMs(from)) out.push(ms);
    m++;
    if (m === 12) {
      m = 0;
      y++;
    }
  }
  return out;
}

/** Header UNIVERSE: monthly top-N membership from the first close with enough eligible contracts. */
export function buildMembership(contracts: Contract[], options: MembershipOptions): Membership {
  const closes = monthCloses(options.from, options.to);
  const eligibleCounts: Membership['eligibleCounts'] = [];
  const months: MonthMembership[] = [];
  let startClose: string | null = null;
  for (let index = 0; index < closes.length; index++) {
    const closeMs = closes[index];
    const eligible = eligibleContracts(contracts, closeMs, options.minBars).length;
    eligibleCounts.push({ close: isoDay(closeMs), eligible });
    if (startClose === null && eligible >= options.minEligibleToStart) startClose = isoDay(closeMs);
    if (startClose === null) continue;
    const members = rankAt(contracts, closeMs, { minBars: options.minBars, topN: options.topN });
    months.push({
      close: isoDay(closeMs),
      closeMs,
      validFrom: isoDay(closeMs),
      validUntil: index + 1 < closes.length ? isoDay(closes[index + 1]) : options.to,
      eligibleCount: eligible,
      rankedCount: members.length,
      members,
    });
  }
  return {
    options,
    eligibleCounts,
    startClose,
    startLaterThan20210701: startClose !== null && startClose > '2021-07-01',
    months,
  };
}

export const UNIVERSE_OPTIONS = {
  from: '2021-01-01',
  to: '2026-07-01',
  minBars: 366,
  topN: 50,
  minEligibleToStart: 20,
} as const satisfies MembershipOptions;

export const BASKET_OPTIONS = {
  from: '2020-02-01',
  to: '2026-07-01',
  minBars: 30,
  topN: 50,
  minEligibleToStart: 0,
} as const satisfies MembershipOptions;

/** Header C3 BASKET: the same ranking with 30-bar eligibility from the 2020-02-01 ranking close. */
export function basketMembership(
  contracts: Contract[],
  options: Partial<MembershipOptions> = {}
): Membership {
  return buildMembership(contracts, { ...BASKET_OPTIONS, ...options });
}

export interface ContractMeta {
  id: string;
  symbol: string;
  assetKey: string;
  firstDay: string;
  lastDay: string;
  bars: number;
  /** The last traded day when the contract ends before 2026-06-30, else null. */
  endedDay: string | null;
}

export interface UniverseFile {
  sourceDatasetHash: string;
  parameters: {
    universe: MembershipOptions;
    basket: MembershipOptions;
    sampleEnd: string;
    rankingWindowDays: number;
    minRankingBars: number;
    maxGapDays: number;
    gapJumpRatio: number;
  };
  contracts: ContractMeta[];
  universe: Membership;
  basket: Membership;
  countsPerMonth: Array<{
    close: string;
    eligible: number;
    members: number;
    basketEligible: number;
    basketMembers: number;
  }>;
  sha256: string;
}

export function contractMeta(contract: Contract, sampleEnd: number = SAMPLE_END_MS): ContractMeta {
  const ended = contractEnded(contract, sampleEnd);
  return {
    id: contract.id,
    symbol: contract.symbol,
    assetKey: contract.assetKey,
    firstDay: isoDay(contract.bars[0].t),
    lastDay: isoDay(contract.bars[contract.bars.length - 1].t),
    bars: contract.bars.length,
    endedDay: ended === null ? null : isoDay(ended),
  };
}

/** JSON with object keys in sorted order at every depth, so a hash does not depend on construction order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface UniverseFileInput {
  sourceDatasetHash: string;
  contracts: Contract[];
  universe?: MembershipOptions;
  basket?: MembershipOptions;
}

/** The universe file: manifest hash, parameters, memberships, contract metadata, counts and its own sha256. */
export function universeFile(input: UniverseFileInput): UniverseFile {
  const universeOptions = input.universe ?? UNIVERSE_OPTIONS;
  const basketOptions = input.basket ?? BASKET_OPTIONS;
  const universe = buildMembership(input.contracts, universeOptions);
  const basket = buildMembership(input.contracts, basketOptions);
  const basketByClose = new Map(basket.months.map((m) => [m.close, m]));
  const basketEligible = new Map(basket.eligibleCounts.map((e) => [e.close, e.eligible]));
  const content: Omit<UniverseFile, 'sha256'> = {
    sourceDatasetHash: input.sourceDatasetHash,
    parameters: {
      universe: universeOptions,
      basket: basketOptions,
      sampleEnd: isoDay(SAMPLE_END_MS),
      rankingWindowDays: RANKING_WINDOW_DAYS,
      minRankingBars: MIN_RANKING_BARS,
      maxGapDays: MAX_GAP_DAYS,
      gapJumpRatio: GAP_JUMP_RATIO,
    },
    contracts: input.contracts
      .filter((c) => c.bars.length > 0)
      .map((c) => contractMeta(c))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    universe,
    basket,
    countsPerMonth: universe.months.map((m) => ({
      close: m.close,
      eligible: m.eligibleCount,
      members: m.members.length,
      basketEligible: basketEligible.get(m.close) ?? 0,
      basketMembers: basketByClose.get(m.close)?.members.length ?? 0,
    })),
  };
  const sha256 = createHash('sha256').update(stableStringify(content)).digest('hex');
  return { ...content, sha256 };
}

/** Header COSTS: slippage per side by the member's rank at the last ranking close. */
export const SLIPPAGE_TIERS = [
  { maxRank: 10, bps: 2 },
  { maxRank: 25, bps: 5 },
  { maxRank: 50, bps: 10 },
] as const;
/** Header COSTS: "A leaving member's exit is charged 10 bps." */
export const LEAVE_SLIPPAGE = 10 / 10_000;
/** Header CONTRACTS: the delisting haircut. */
export const DELIST_HAIRCUT = 0.02;

/** The slippage tier of a rank, 1 to 50; any other rank throws. */
export function tierSlippage(rank: number): number {
  if (!Number.isInteger(rank) || rank < 1) throw new Error(`Rank ${rank} is not a positive integer`);
  for (const tier of SLIPPAGE_TIERS) if (rank <= tier.maxRank) return tier.bps / 10_000;
  throw new Error(`Rank ${rank} is outside the top ${SLIPPAGE_TIERS[SLIPPAGE_TIERS.length - 1].maxRank}`);
}

/** The broad phase's costs beyond the fee: SimOptions.broad. */
export const BROAD_COST: BroadCost = {
  slippageForRank: tierSlippage,
  leaveSlippage: LEAVE_SLIPPAGE,
  delistHaircut: DELIST_HAIRCUT,
};

/** Header COSTS: the taker fee on every unit of traded notional. Slippage comes from BROAD_COST, so it is 0 here. */
export const BROAD_FEE: TrendCost = { fee: TREND_COST.fee, slippage: 0 };
