"""HORIZON L1 LOCK (ledger id horizon-l1): taking the other side of a liquidation burst on Lighter perpetuals, a
declared set of 6 trials. Drafted 2026-11-14 by the lead and revised after an independent Opus gate review of the first
draft. This module IS the specification. No price, return or fill was read for this study before this text and the code
beside it were written, and nothing may be changed after the first real run.

THE QUESTION. After a burst of forced selling (longs liquidated) on a Lighter perpetual, does a long that a taker order
opens 5 minutes after the burst has ended earn more than it costs, and after a burst of forced buying (shorts
liquidated) does a short? Lighter's standard account pays no fee, so the cost is the spread paid by a taker order,
measured from the fold's prints, plus realised funding. This is a tier 2 question (a decision for a small account).
Whether the burst itself is what pays is a separate claim (rules 8 and 9).

WHERE THE IDEA COMES FROM, AND WHAT THIS READ CAN SAY. One working paper (Jia, Moallemi, Wang and Zeng, SSRN 7270041).
On Hyperliquid, ten coins (BTC, ETH, SOL, HYPE, XRP, DOGE, ENA, FARTCOIN, SUI, LINK), 2025-03-27 to 2026-06-30, volume
weighted, the 2025-10-10 crash excluded, the mid price moves against the forced trade by 16.04, 21.03, 24.21 and 28.48
basis points at 5, 30, 60 and 120 minutes after a liquidation fill (its Table 15; each fill has its own clock, so inside
a long burst a fill's minute 5 lies inside the burst; liquidations count in both roles). The steps that matter here are
4.99 bps (5 to 30 minutes), 8.17 (5 to 60) and 12.44 (5 to 120). With the 2025-10-10 crash included the same path reads
+2.84 at 5 minutes and -96.70 at 120, and this lock leaves that day in. That is a move of the mid, not a trade: it pays
no spread, it is volume weighted, no standard errors are reported, and it is measured on another venue. Lighter is a
different venue with a 300 ms taker delay, so this is a new test and not a replication. The earlier Lighter study
(lighter-l1) did not use liquidations as a signal, but its own-price reversal rules at 30 to 120 minutes lost on these
same data, which is prior knowledge for the plain-rebound control. The days from 2025-07-01 to 2026-06-30 were explored
by that study for other rules, so this read is a development read and not a clean out-of-sample test. The confirmation
slice 2026-07-01 to 2026-10-31 is NOT read here (rule 11), and it falls after Lighter removed its oracle price caps on
2026-07-10, which makes it a different regime.

CODE IS PART OF THE LOCK. lock_digest() is the sha256 of the bytes of every horizon/l1/*.py file (sorted by name, this
file included). Every result records that digest and the git HEAD commit. Any change to a horizon/l1/*.py file after the
first real run changes the digest and needs a new ledger id. The anchor also holds the sha256 of lighter/fold_trades.py,
which horizon/l1/fold_liq.py imports. The command run refuses to run when the git working tree has uncommitted changes
under scripts/research/py/horizon/l1, unless the environment attests a clean tree (HORIZON_GIT_HEAD and
HORIZON_TREE_CLEAN=1, for the research image that has no .git), and the result then says "attested by environment". The
attestation is accepted only when no .git exists above the horizon/l1 folder, so a repository where git itself fails
makes the run refuse. The statistics helpers live in horizon/l1/stats.py (a copy of the e1 helpers) so they are inside
the digest. The research image runs with --network none.

REGISTRATION ANCHOR. scripts/research/py/records/horizon_l1_registration.json holds the lock digest, the sha256 of
lighter/fold_trades.py, of lighter/lock.py, of the fold manifest, of the liquidation pass manifest, of markets.json,
of the funding manifest, of the panel manifest and of the funding files (funding_files_sha256, one digest over the
sorted names and sha256 of every market_*.parquet in the funding folder), and the owner's signature (the date and the
lock digest the owner signed in chat). The command register-check prints what the file should contain. The command run
refuses to run when the file is absent or anything differs, and a SYNTHETIC marker alone never disables a guard (the
real data carry no synthetic flag). The commands panel, register-check and event-count compute no return.

1. DATA (every read goes through horizon/l1/data.py, which enforces the span guards, except that the command panel
   reads the fold once through lighter/fold_trades.py and its own span guard). (i) The Lighter fold, per market and
   UTC minute (lighter/fold_trades.py, version v1): market_id, minute, buy_usd, sell_usd, last_px, last_buy_px,
   last_buy_ts, last_sell_px, last_sell_ts, first_buy_px, first_buy_ts, first_sell_px, first_sell_ts, with the fold
   manifest and markets.json. Prices are raw integers per market and only ratios of two prices of the same market are
   used. (ii) The liquidation pass (horizon/l1/fold_liq.py, version l1v1): per market and minute, liq_sell_usd (forced
   sells), liq_buy_usd (forced buys) and their row counts, from rows with trade_type liquidation only (other non-trade
   types are counted in its manifest and ignored). The forced side is the taker side: the taker bought (forced buy)
   when is_maker_ask is true and sold (forced sell) otherwise. Where the column taker_position_size_before is present
   the taker is closing its own position (the pass counts rows_side_inconsistent per day and rows_side_unchecked for
   null values). The run stops if, over the whole span, rows_side_inconsistent exceeds MAX_INCONSISTENT_SHARE = 0.1%
   of the liquidation rows. It reports the inconsistent and unchecked counts and the days that have any. Inconsistent
   rows stay in the volume on the taker side, because the minute totals cannot drop a single row. (The first draft of
   this rule stopped on any inconsistent row. The finished pass found 197 of 1,179,050 liquidation rows, 0.017%, on 32
   days from 2026-04-29, 97 of them on 2026-06-05, before any return was computed. The share limit replaces the zero
   limit for that reason, and the owner signs this text.) (iii) The Lighter hourly funding files
   (lighter/fetch_funding.py output: timestamp in unix seconds, rate_long_pays as a fraction per hour) with their
   manifest. (iv) markets.json for the market type and symbol. FOLD_FIRST_DATE is 2025-01-17 and HARD_LAST_DATE is
   2026-06-30: nothing dated 2026-07-01 or later is ever read, with no override. Every fold and pass day in the span
   must have a manifest line of the expected version with a matching file sha256, else the run stops. The command
   panel rewrites the fold into one file per market (the columns above, the span only, a derived copy with no new
   information) and checks the price scale: any jump between consecutive printed minutes of a market with |ln(last_px
   ratio)| above ln 5 is listed, and the run stops on any listed jump not named in the tuple KNOWN_SCALE_JUMPS. The
   panel output (530 days, 206 markets, 53,857,421 rows) listed nine jumps, all in three SPOT markets that the study
   never reads (2052 AAVE/USDC, 2054 LDO/USDC, 2055 AZTEC/USDC) and none in any perp market, so those nine are named
   in the tuple (market id and minute start, as listed) before any return is computed.

2. BURSTS (events). Per market and per side separately, minutes with liquidation volume of that side are merged into a
   burst when two consecutive such minutes have starts at most BURST_GAP_MS = 300,000 ms apart. A burst has a start
   minute t0, a last minute t1, an end E = t1 + 60,000 ms, a volume (the sum of the side's liquidation USD), a row count
   and a duration. Bursts are formed over the whole data from FOLD_FIRST_DATE, so warm-up bursts exist. The burst end is
   known only when five further minutes have passed without a liquidation of that side, which is at E + 5 minutes. The
   DECISION TIME is therefore D = E + ENTRY_OFFSET_MIN = E + 5 minutes, with no slack (the pass timestamps can run up to
   about 0.4 s before the archive's transaction time). A burst is a candidate when its volume is at least BURST_MIN_USD
   = 100,000 and its row count at least BURST_MIN_ROWS = 3. This is an absolute size and not the plan row's "top 0.5% of
   liquidation notional", chosen because it is a single declared number that does not depend on the sample; the
   deviation is deliberate. Side S is a burst of forced sells (the trade is a long), side B a burst of forced buys (the
   trade is a short). Candidates of one market and side are taken in time order. A candidate is an EVENT unless an
   earlier EVENT of the same market and side, whatever its later eligibility or fill status and including events before
   EVENTS_FROM, satisfies t0(candidate) - E(earlier) < RETRIGGER_MIN = 125 minutes (so the holds of one market and side
   never overlap; an exit search, which reaches E + 135 minutes, may run up to 4 minutes into the next event's decision
   time, which is allowed). Events with E before EVENTS_FROM (2025-02-17, a 30 day warm-up) are not traded, and events
   whose last exit search would pass HARD_END_MS (E + 120 + 16 minutes) are dropped and counted. Both sides can be
   events in the same market.

3. ELIGIBILITY AT THE DECISION TIME D (market type perp, point in time). The 1,440 minutes before D contain at least 360
   minutes with buy_usd + sell_usd above zero, and the market has a spread proxy (rule 4) from at least SP_MIN_PAIRS =
   200 qualifying minutes in the 7 days before D. An event failing this is excluded and counted by reason in the report,
   not in clause (d) of rule 6 (which covers eligible events only). The scope is all perp markets in markets.json
   (crypto, traditional-market and unclassified symbols), judged together; the result is also reported by the symbol
   classes of lighter/lock.py.

4. TRADE AND FILLS. An order is a taker order sent at a minute boundary t. It fills at the first print of EITHER side
   with timestamp at or after t + 500 ms. An ENTRY searches the minute starting at t only; with no such print the
   event is unfilled (counted in clause (d) of rule 6). An EXIT searches that minute and the next 15 minutes. A fill
   by a print of the order's own side (a taker-buy print for a buy) is at the print price. A fill by a print of the
   other side is at the print price moved against the order by SP bps: a buy at sell_print_px x (1 + SP / 10,000), a
   sell at buy_print_px x (1 - SP / 10,000). On a timestamp tie the worse price for the order is used. SP = max(SPM,
   x(m), x(m - 1)) where m is the fill minute, x(m) = (last_buy_px - last_sell_px) / ((last_buy_px + last_sell_px) /
   2) in bps when both exist in minute m and their timestamps differ by at most 2,000 ms (else 0, and a negative value
   counts as 0), and SPM is the median of x over the qualifying minutes of the 7 days before D. (Waiting for a
   same-side print is not used: trade signs persist, so it would fill each leg late exactly when waiting helps.) A
   long is a buy at entry and a sell at exit, a short the reverse. The entry order is sent at D. The exit order is
   sent at E + h minutes for h in EXIT_OFFSETS_MIN = (30, 60, 120), so the holds are 25, 55 and 115 minutes. An exit
   with no print in its 16 minutes fills at last_px of the last minute with a print at or before E + h + 15 (but not
   before the entry minute) moved against the order by SP / 2, and is flagged, with SP = max(SPM, x(m), x(m - 1)) at
   the minute m of that last_px. The fold keeps first-print columns only for prints at least 500 ms into their own
   minute, so in the exit minutes after the first a print in the first 500 ms of a minute is not seen (a limit of the
   data, part of the rule, with an unknown direction and a small expected size). So an event with an entry fill always
   has an exit: nothing observed after the entry removes an event. Return per trade = exit fill / entry fill - 1 for a
   long and 1 - exit fill / entry fill for a short, a simple return on the notional, less the realised funding: for
   each Lighter funding stamp s with entry fill ts < s <= exit fill ts, a long pays rate_long_pays and a short
   receives it, as a fraction of the notional. A stamp missing from the funding file inside the hold is not filled in:
   the event is flagged funding_gap and kept. A market whose funding manifest status is "empty" (Lighter listed no
   funding rows at all, 8 of the 198 markets, 5 eligible events) has no funding file and its trades are charged zero
   funding and flagged funding_gap. A market with no funding file and any other status stops the run. The fallback
   fill is stamped at the end of its minute m (m + 60,000 ms), so its latency can be negative and a funding stamp at
   that minute end is charged. There is no fee, no stop and no leverage in the judged result.

5. UNITS AND CLUSTERS. The cluster is the UTC day of D, because liquidation cascades hit many markets at once. A
   cluster's value is the equal-weight mean of the trade returns of its events. Statistics use clusters.

6. THE SIX TRIALS. Trial ids S-30, S-60, S-120, B-30, B-60, B-120 (side x exit offset). For each, the statistic is the
   mean of cluster values. A trial PASSES only if ALL of these hold: (a) the mean is at least PASS_MIN_MEAN = 0.0005
   (5 basis points a trade); (b) the lower bound is above PASS_MIN_BOUND = 0.00013 (1.3 basis points), where the bound
   is the smaller of the bootstrap bound and the t bound, both one-sided at TRIAL_ALPHA = 0.05 / 6, the bootstrap
   using numpy.random.default_rng(BOOT_SEED), one generator for the six trials in TRIAL_IDS order, each trial drawing
   rng.integers(0, max(n, 1), size=(BOOT_RESAMPLES = 10,000, max(n, 1))) (every trial draws, and n below 2 gives a NaN
   bound), numpy.quantile(method="linear"), and the t bound being mean - t.ppf(1 - TRIAL_ALPHA, n - 1) x s / sqrt(n)
   with ddof 1; (c) the number of clusters is at least MIN_CLUSTERS = 30; (d) per trial, the share of eligible events
   lost to a missing entry fill is at most MAX_EXCLUDED_SHARE = 10% (events lost for the span end or for the retrigger
   rule are not eligible events and are not counted here). The leave-one-out clause of the e1 lock is not used, it is
   implied by (a) and (b). The plan's kill line for this test was a lower bound under 1.3 basis points; (a), (c) and
   (d) are the lead's additions. Power: the return-free event count of 2026-11-14 found 1,896 eligible forced-sell
   events on 398 days and 1,157 eligible forced-buy events on 339 days (ETH, BTC and HYPE carry 70% of the forced
   sells, and October 2025 has the most events). With about 400 day clusters and a cluster standard deviation of 100
   basis points, the smallest mean that clears (b) is about 13 basis points, which is above the paper's own gross
   12.4, so clause (b) and not clause (a) is the likely binding one and a pass needs an effect larger than the
   paper's. Passing none of the trials is a result: the idea is closed for tier 2 and no part of it is rerun with
   other settings. A pass makes the liquidation reversal eligible for gate G0 of the tier 2 plan, which still needs
   the fill probe (G3), the owner's gates and the confirmation read of rule 11.

7. REPORTED, NOT JUDGED (descriptive, no trial, cannot rescue a failed trial). For every trial: the numbers of bursts,
   candidates, events, eligible events, events with an entry fill, markets and clusters with the exclusion reasons;
   the burst duration (median and 90th percentile); the mean, median, standard deviation, share positive and t of
   cluster values and of event returns; the volume-weighted mean event return; the result by month, by symbol class
   and by market (the ten largest by event count); the result without 2025-10-10; the worst move against the trade
   inside the hold (the largest adverse change of last_px between the entry fill and the exit fill) and the share of
   events that moved more than 2% and more than 30% against the trade; the mean event return (not the cluster mean)
   after adding 1 and 2 basis points a side of extra cost; the fill latency (fill timestamp minus the order boundary)
   at entry and exit; the number of flagged exits, ties and funding gaps; the entry offset profile (the same trial
   with the entry order sent at E + 5, 6, 10 and 15 minutes, exits unchanged, with eligibility and SPM re-evaluated at
   E + the offset; the offsets are at least 5 because the burst end is not known earlier); the realised funding sum;
   and a run the account could follow: 10 USD per trade, at most 10 positions open at once (1x gross of 100 USD),
   events taken in time order, events skipped when the account is full.

8. MATCHED CONTROLS (the claim line, computed in this run, adds no trial). For each event with an entry fill, controls
   are decision times D' of the same market chosen as follows. Candidates are the minute boundaries in the 30 days
   before the event's t0 that satisfy: D' + 120 minutes is at most t0 (the control's exit orders are sent before the
   event's burst starts, and an exit search may run up to 10 minutes past that), no liquidation volume of either side
   exists in the minutes [D' - 125 minutes, D'), the eligibility of rule 3 holds at D', and fills exist at the same
   offsets for all three exits. The preceding move R_pre(X) = last_px(minute X - 1) / last_px(minute X - 61) - 1, each
   last_px carried back at most CARRY_BACK_MIN = 5 minutes (an X without both has none), is computed at the event's D
   and at each candidate. The controls are the CONTROLS_PER_EVENT = 5 candidates with R_pre nearest to the event's,
   chosen one at a time with each later choice at least 125 minutes from the earlier ones; ties break by the earlier
   D'. A control is traded exactly as the event (same side, same offsets and fills). An event with fewer than
   CONTROLS_MIN = 3 controls has no control and is counted. The excess of an event, per trial, is its return minus the
   mean return of its controls. A cluster's excess is the mean excess of its events. The claim statistic is the
   one-sided bound (same bootstrap and t bound, level CLAIM_ALPHA = 0.05, a separate generator seeded BOOT_SEED + 1)
   of the mean cluster excess. The controls are matched on the preceding move and have no recent liquidation, so they
   separate the burst from a plain rebound after a fall.

9. THE CLAIM LINE. A pass of a trial in rule 6 with a claim bound of rule 8 at or below zero means the trade made money
   but the burst is not what pays (a rebound after any similar fall would have paid the same). That is reported, and the
   bet is still eligible for tier 2 on its own result.

10. WHAT IS NOT DONE. No parameter (size, gap, offsets, search window, costs) is tuned. The 2025-10-10 crash is NOT
    removed from the judged result. Opposite-side bursts in one market are not netted. No other venue, no maker orders,
    no stop, no leverage in the judged result. No result is read before the digest, the manifests and the owner's
    signature are registered. The ledger gets 6 trials for this id (the total becomes 4,497).

11. CONFIRMATION. Fold days from 2026-07-01 onward stay unread. If a trial passes, a confirmation read of 2026-07-01 to
    2026-10-31 needs its own lock, its own liquidation pass for those days, and the owner's signature.

PREDICTION (registered before any run, also the constant PREDICTION below): "Registered 2026-11-14 by the lead before
any return was computed: at least one of the six trials passes with probability about 0.1. The mean return of the
forced-sell long is positive at 60 and 120 minutes with probability about 0.6, and the forced-buy short is the weaker
side. The most likely failure is clause (b), a lower bound that cannot clear 1.3 basis points with day clusters this
noisy, and not a negative mean."
"""

from __future__ import annotations

import datetime as dt
import functools
import hashlib
from pathlib import Path

LEDGER_ID = "horizon-l1"

PREDICTION = (
    "Registered 2026-11-14 by the lead before any return was computed: at least one of the six trials passes with "
    "probability about 0.1. The mean return of the forced-sell long is positive at 60 and 120 minutes with probability "
    "about 0.6, and the forced-buy short is the weaker side. The most likely failure is clause (b), a lower bound that "
    "cannot clear 1.3 basis points with day clusters this noisy, and not a negative mean."
)

SIDES = ("S", "B")
EXIT_OFFSETS_MIN = (30, 60, 120)
TRIAL_IDS = tuple(f"{side}-{h}" for side in SIDES for h in EXIT_OFFSETS_MIN)
TRIALS = len(TRIAL_IDS)

MINUTE_MS = 60_000
DAY_MS = 86_400_000
HOUR_MS = 3_600_000


def _ms(day: dt.date) -> int:
    return int(dt.datetime(day.year, day.month, day.day, tzinfo=dt.UTC).timestamp() * 1000)


FOLD_FIRST_DATE = dt.date(2025, 1, 17)
EVENTS_FROM_DATE = dt.date(2025, 2, 17)
HARD_LAST_DATE = dt.date(2026, 6, 30)  # nothing dated later is ever read
EVENTS_FROM_MS = _ms(EVENTS_FROM_DATE)
HARD_END_MS = _ms(HARD_LAST_DATE) + DAY_MS  # exclusive end of the readable span

BURST_GAP_MS = 5 * MINUTE_MS
BURST_MIN_USD = 100_000.0
BURST_MIN_ROWS = 3
RETRIGGER_MIN = 125
ENTRY_OFFSET_MIN = 5
ENTRY_PROFILE_MIN = (5, 6, 10, 15)
EXIT_SEARCH_MIN = 15
FILL_DELAY_MS = 500
PAIR_MAX_GAP_MS = 2_000
SP_WINDOW_DAYS = 7
SP_MIN_PAIRS = 200
ACTIVITY_WINDOW_MIN = 1_440
ACTIVITY_MIN_ACTIVE_MIN = 360
SCALE_JUMP_LN = 1.6094379124341003  # ln 5
# (market_id, minute start in ms), fixed from the panel output of 2026-11-14: nine jumps, all in spot markets
KNOWN_SCALE_JUMPS: tuple[tuple[int, int], ...] = (
    (2052, 1_770_944_400_000),
    (2052, 1_770_944_460_000),
    (2052, 1_770_944_640_000),
    (2054, 1_776_354_120_000),
    (2054, 1_776_356_520_000),
    (2055, 1_771_584_900_000),
    (2055, 1_771_585_020_000),
    (2055, 1_771_592_640_000),
    (2055, 1_771_596_720_000),
)

CONTROLS_PER_EVENT = 5
CONTROLS_MIN = 3
CONTROL_LOOKBACK_DAYS = 30
CONTROL_QUIET_BEFORE_MIN = 125
CONTROL_HOLD_MIN = 120
CONTROL_SPACING_MIN = 125
RPRE_LOOKBACK_MIN = 60
CARRY_BACK_MIN = 5

BOOT_RESAMPLES = 10_000
BOOT_SEED = 20_261_115
TRIAL_ALPHA = 0.05 / TRIALS
CLAIM_ALPHA = 0.05
PASS_MIN_MEAN = 0.0005
PASS_MIN_BOUND = 0.00013
MIN_CLUSTERS = 30
MAX_EXCLUDED_SHARE = 0.10
MAX_INCONSISTENT_SHARE = 0.001

__all__ = ["LEDGER_ID", "PREDICTION", "SIDES", "TRIALS", "TRIAL_IDS"]


@functools.lru_cache(maxsize=1)
def lock_digest() -> str:
    """sha256 over the bytes of every horizon/l1/*.py file, sorted by name (this file included)."""
    h = hashlib.sha256()
    for path in sorted(Path(__file__).resolve().parent.glob("*.py"), key=lambda p: p.name):
        h.update(path.name.encode() + b"\0")
        h.update(path.read_bytes())
        h.update(b"\0")
    return h.hexdigest()
