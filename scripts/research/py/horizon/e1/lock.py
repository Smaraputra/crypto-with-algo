"""HORIZON E1 LOCK (ledger id horizon-e1): BTC-hedged shorts on Binance USDT-M perpetuals after two kinds of Binance
exchange warning, a declared set of 4 trials. Drafted 2026-11-14 local time (2026-11-13 UTC) by the lead, revised the
same day after an independent Opus gate review of the first draft. This module IS the specification. No price, return or
perp bar was read before this text and the code beside it were written, and nothing may be changed after the first real
run.

THE QUESTION. After Binance announces that a token joins the monitoring tag list (class T) or will be delisted from spot
(class D), does a short opened about two minutes after the announcement stamp, hedged with a long Bitcoin perpetual of
equal notional, earn more than its costs over the next 4 or 24 hours? This is a tier 2 question (a decision for a small
account). A tier 1 claim (the announcement itself moves the price) is separate (rule 11).

WHAT THIS READ CAN AND CANNOT SAY. The idea comes from one preprint (Research Square rs-11588547, Zhang, Kang and Sun,
not peer reviewed). Its Table 2 reports a mean log return of -9.59 percent (winsorised at the 1st and 99th percentiles,
t -4.52, 142 tags with three matched untagged tokens each, matched difference -8.61) from the first full minute after
the stamp to the end of day 1, on 155 first-time tags in 26 announcements between 2023-07-26 and 2026-10, with the
median stamp 12 seconds into the minute. It reports no level for perp-listed tokens alone: its Table 11 says tagged
tokens with a perpetual lose 2.3 points more in the stamp minute and 5.7 points less over the rest of day 1 than tagged
tokens without one (announcement fixed effects), so the -9.59 overstates what a perp short can earn. The preprint's
first announcement (2023-07-26, the day the tag was introduced, 13 matched tags) shows no fall, and dropping it makes
the declines larger, so the record includes it (rule 1). The class T events of this lock are the preprint's events (its
Section 3: 167 tags in 26 announcements from 2023-07 to 2026-10, the first tag of each token kept with 1 repeat removed,
then 11 tokens dropped for lack of data, leaving 155 first-time tags; the record has 167 token mentions in 27 notices
and 166 first-time tags), and its returns are one-minute SPOT prices of the USDT pairs, not perp prices. This read is
therefore a re-measurement of the same events under a different rule (a delayed entry, costs, funding, a stop and a
hedge). It can kill the rule or show that it survives costs on the same events. It cannot validate the effect, because
there is no independent history, and a class T pass is in-sample (rule 9). The independent record is the forward events
after the freeze (rule 12). Class D has indirect evidence only: Table 8 Panel B of the same preprint puts a further loss
for tagged tokens in the three days around their delisting announcement (matched differences -3.50, -6.11 and -8.38
points inside the 30, 60 and 90 day windows, t below -3 each), measured in days and not in minutes, and it is no test of
a minute-level short. Most class D tokens were tagged earlier (73 of the 76 class D tokens with a symbol in the record,
at a median of 63 days before and a range of 3 to 1,022 days), so class D is the second stage of the same story and its
surprise is smaller. A vendor page (CryptoListing.ws) reports a median 24 hour low of -15.2 percent after 31 tag
announcements since 2026-04. It is a median of per-announcement extremes, not a return, and its events overlap class T,
so it is not evidence here.

CODE IS PART OF THE LOCK. lock_digest() is the sha256 of the bytes of every horizon/e1/*.py file (sorted by name, this
file included, scan_events.py included). Every result file records that digest and the git HEAD commit. Any change to a
horizon/e1/*.py file after the first real run changes the digest and needs a new ledger id with its trials added to the
ledger. The command run, which computes the trials, refuses to run when the git working tree has uncommitted changes
under scripts/research/py/horizon/e1, unless the environment attests a clean tree (HORIZON_GIT_HEAD and
HORIZON_TREE_CLEAN=1, for the research image that has no .git), and the result then says "attested by environment".
Every result also records the numpy, pandas and scipy versions. The research image runs with --network none.

REGISTRATION ANCHOR. scripts/research/py/records/horizon_e1_registration.json (outside horizon/e1/, written by the lead
at registration) holds the lock digest, the sha256 of the frozen event record, the sha256 of the fetch plan, the sha256
of the manifest of the downloaded files, and the owner's signature (the date and the lock digest the owner signed in
chat). The command register-check prints what the file should contain. The command run refuses to run when the file is
absent or anything differs. The commands fetch-plan, register-check and data-check compute no return: data-check opens
the planned files for structure only, counts rows and lists problems, and needs no anchor. The command smoke runs the
whole pipeline in memory on the real files before registration, to find a crash, and prints only counts of pairs,
exclusions and clusters (never a return, a bound or a pass flag); it needs the frozen record and a clean plan. The
frozen record's sha256 is also the constant EVENTS_SHA256 of this module: a real run refuses any other record, and the
SYNTHETIC marker of a data folder is refused for this one (the marker alone never disables a guard: a synthetic run also
needs meta.synthetic true in the record and synthetic true on every manifest line, which the real downloader never
writes).

1. EVENTS (frozen). The frozen event record is scripts/research/py/records/horizon_e1_events.json, written once by
   horizon/e1/scan_events.py on 2026-11-13 UTC (scan time in its meta) from Binance's public announcement lists (general
   news catalog 49 and delisting catalog 161), titles and release stamps only, with no price read. Its sha256 is in the
   anchor. The scan fails when a catalog reaches its page cap, and the record states pages, article count and oldest and
   newest stamp per catalog. Class T: a notice whose title contains "Extend the Monitoring Tag to Include" (or "Extend
   the Monitoring Tag to"), the tickers being the list after those words up to "and Remove", ", Remove" or " on <date>",
   plus the introduction notice of 2023-07-26 03:00 UTC (article code b0f241491d0e4d75aa2f8752b7bf8af5), whose title
   names no token and whose 26 tokens are copied from its body and checked against the body at every scan. Removal of a
   tag and removal of a seed tag are not events. Class D: a notice whose title matches "Binance Will Delist <tickers> on
   <date>" or "Binance Announced the <ordinal> Batch of Vote to Delist Results and Will Delist <tickers> on <date>"
   (spot delisting). Margin, futures, staking, P2P, loan, option and leveraged-token delistings, rebranding delistings
   and delisting updates are not events. Tickers have 1 to 12 characters (the one-letter ticker D is a token). The stamp
   is the article's releaseDate in milliseconds. Only notices with a stamp from EVENTS_FROM_MS (2022-01-01 00:00 UTC;
   catalog 161 starts on 2022-02-17 and catalog 49 covers January 2022) and before FREEZE_MS are in the record. The
   record also carries, for every title that mentions a monitoring tag or a delisting, a decision and a reason (so a
   missed notice is visible), and the futures delisting titles that name symbols (context for rule 10). A token counts
   once per class, at its first notice in the record, and a later notice naming it is dropped from that class (the
   preprint's first-tag rule). A token appearing in both classes counts in both. RECONCILIATION with the preprint's
   Section 3 and Table 1: it counts 167 tags in 26 announcements, keeps the first tag of each token (1 repeat removed,
   166) and drops 11 tokens that have no daily data before the announcement, have traded under 30 days, or are
   stablecoins or leveraged tokens, leaving 155. The record holds 167 token mentions in 27 notices and 166 first-time
   tags, so the token counts agree exactly before the drops. The announcement count differs by one (the record has 2, 4,
   9 and 12 notices for 2023 to 2026 against the preprint's 2, 4, 8 and 12, and the extra 2025 notice is unexplained).
   102 of the 166 first-time tags (61 percent) have a symbol covering the stamp, against 67.6 percent of the preprint's
   tags with a perpetual. Class T has 102 tokens with a symbol in 26 of its 27 notices, class D has 76 tokens in 29 of
   its 39 notices.

2. SYMBOLS AND ELIGIBILITY. The record fixes, for every (ticker, notice), the archive symbol: the first of X+"USDT",
   "1000"+X+"USDT", "1000000"+X+"USDT" whose daily 1m kline files in Binance's public archive (futures/um) start at
   least 1 day before the stamp's UTC day and end on or after it. A ticker with no such symbol has none (reason
   recorded: no archive symbol, listed too late, ended before the stamp). The tuple OVERRIDES in scan_events.py, keyed
   by (ticker, article code) and fixed from names alone before any price was read, replaces the rule for the cases it
   lists (DODO of the 2026-05-22 notice is excluded: its old contract ended in 2022 and no title ties the later DODOX
   contract to the notice's token). Ticker reuse was checked on 2026-11-13 by comparing every chosen symbol's span with
   the notice's date and name: none was found beyond that entry. The harness never remaps a symbol. Five checks decide
   eligibility, the first three from the record with no price and the last two from the bars. (s1) A pair with no symbol
   is reported by reason. (s2) A pair whose symbol is named in the body of a futures delisting notice published before
   the stamp, whose latest scheduled time is at or after the stamp, is not eligible (futures_delist_pending: the
   contract is already scheduled to settle, so a new short is not a tradable bet). The record stores each such notice's
   USDT symbols and scheduled times, read from its body. (s3) A pair whose symbol or BTCUSDT has a day missing from the
   archive listing inside [stamp day - 1, stamp day + 2] is excluded as data_missing, and the record lists those days
   per pair. (s4) The 1,440 minutes with open_time in [M - 1,440 min, M), where M is the stamp's minute start, contain
   at least 360 bars with volume above zero (the perp traded, not only existed). (s5) The 1m bar at the entry minute
   exists with volume above zero (a print to fill against). A day that the record lists as present but is absent from
   the manifest, failed to download (manifest status missing) or was repaired by the downloader (duplicate or bad rows)
   stops the run, it is never an exclusion. A funding month that the archive does not have (manifest status missing) is
   the exception: its settlements are missing, so the pair is flagged funding_gap and kept (rule 7). Missing bars inside
   a present file are handled by rule 3 only. Every excluded pair is listed with its reason. No pair that passed (s1) to
   (s5) is excluded for anything observed after the entry.

3. CLOCK, ENTRY, EXITS. Let s be the stamp in milliseconds. The first full minute that starts after the stamp starts at
   m0 = floor(s / 60,000) x 60,000 + 60,000, so a stamp exactly on a minute boundary falls before m0 as the preprint's
   t0 does. The entry is at the OPEN of the 1m bar with open_time m0 + ENTRY_DELAY_MINUTES x 60,000 (1 minute, so about
   108 seconds after a stamp 12 seconds into a minute). The exit time is te = entry + h x 3,600,000 for h in
   HORIZONS_HOURS (4 and 24). The token's exit price Px is the OPEN of the bar at te if that bar has volume above zero,
   else the CLOSE of the last bar with volume above zero at or before te. If that bar's open_time is more than
   STALE_EXIT_MINUTES = 30 minutes before te (the contract stopped trading, for example a delisting settlement), the
   trade is flagged truncated and stays in. The BTC exit price Bx is the open of the BTCUSDT bar at te, or, when that
   bar is missing, the close of the last BTCUSDT bar at or before it (the trade is flagged btc_carried and stays in,
   because nothing observed after the entry excludes a pair). For a truncated trade the exit time is the close of the
   token's last traded bar (its open_time plus 60 seconds), Bx follows the same rule at that time, and funding and costs
   run to that time, so the hedge never outlives the token leg. The stop scan of rule 5 runs over the bars from the
   entry bar up to, not including, the bar at te, and for a truncated trade up to, including, the token's last traded
   bar.

4. THE POSITION. Per 1.0 of short notional: short the token's perpetual at the entry price Pe and go long BTCUSDT
   (perpetual) for 1.0 notional at its entry bar's open Be (the same entry minute). Gross result = (Pe - Px) / Pe + (Bx
   - Be) / Be. The BTC leg exists only to remove the market move. The unhedged short (first term only) is reported but
   never judged.

5. THE STOP. The token leg has a stop at Pe x (1 + STOP_ADVERSE) with STOP_ADVERSE = 0.30. It triggers on the last-trade
   high of the 1m bars (not on mark price), and is checked on every bar of rule 3's scan range. On the first bar whose
   high is at or above the stop level, the token leg exits at max(stop level, that bar's open) and the BTC leg exits at
   that bar's open. No re-entry. The position is flagged stopped.

6. COSTS (all per side, in basis points of the notional traded on that leg). Fee: TAKER_FEE_BPS = 5.0 (Binance USDT-M
   taker 0.05%, no VIP or BNB discount). Slippage on the token leg: max(SLIP_TOKEN_FLOOR_BPS = 10.0,
   SLIP_TOKEN_RANGE_SHARE = 0.25 x the traded bar's (high - low) / open in bps), where the traded bar is the entry bar,
   the exit bar (the last bar with volume above zero for a truncated trade) or the stop bar. Slippage on the BTC leg:
   SLIP_BTC_BPS = 1.0. Entry and exit are both charged on both legs. The cost of the exit legs is charged on the
   notional at exit (leg value Px/Pe for the token and Bx/Be for BTC). A re-run with all slippage doubled is reported
   (not judged).

7. FUNDING. For each leg, the settled funding payments with settlement time calc_time in (entry, exit] from Binance's
   archive funding files (calc_time, funding_interval_hours and last_funding_rate), each on the notional at that
   settlement: the close of the last 1m bar before calc_time divided by Pe for the token leg (by Be for the BTC leg),
   per 1.0 of entry notional. The short token leg receives the rate (pays when it is negative). The BTC long leg pays
   the rate (receives when negative). The sum is added to the net result. The funding series of a symbol is the merged
   calc_times of its monthly files, and the exit is the exit time of rule 3 (the bar at te, the stop bar or the
   truncated time). A settlement is missing when two consecutive calc_times of that series, from the last one at or
   before the entry to the first one after the exit, are more than the earlier row's funding_interval_hours plus 1
   minute apart, or when the series has none at or before the entry or none after the exit. Nothing is filled in: the
   pair is flagged funding_gap and kept, and the number of such pairs is reported.

8. UNITS AND CLUSTERS. The unit of analysis is the announcement. A unit's value is the equal-weight mean of the net
   results of its eligible tokens. Units whose entry times lie within CLUSTER_GAP_HOURS = 24 of each other, chained, are
   merged into one cluster whose value is the equal-weight mean of its units' values. Clusters are formed inside a class
   only. Statistics use clusters. In the frozen record no two same-class notices are that close, so clusters equal
   notices there, and the merge exists for the forward sample.

9. THE FOUR TRIALS. Trial ids T-4h, T-24h, D-4h, D-24h (class x exit horizon). For each, the statistic is the mean of
   cluster values of the net hedged result (rule 4 less rules 6 and 7, after the stop of rule 5). A trial PASSES only if
   ALL of these hold: (a) the mean is at least PASS_MIN_MEAN = +0.02 (2% of the short notional per cluster); (b) the
   lower confidence bound is above zero, where the bound is the smaller of the bootstrap bound and the t bound, both
   one-sided at TRIAL_ALPHA = 0.05 / 4 = 0.0125 (the hypothesis is directional and 4 is the number of trials; this is
   half as strict as a two-sided 0.0125, which is 0.00625 one-sided, and the owner may tighten it when signing): the
   bootstrap bound is numpy.quantile(means, TRIAL_ALPHA, method="linear") over BOOT_RESAMPLES = 10,000 bootstrap means
   made with numpy.random.default_rng(BOOT_SEED), one generator used for the four trials in the order of TRIAL_IDS, each
   trial drawing rng.integers(0, n, size=(BOOT_RESAMPLES, n)) cluster indices (n clusters; every trial draws, including
   one that fails clause (d)); the t bound is mean - t.ppf(1 - TRIAL_ALPHA, n - 1) x s / sqrt(n) with s the sample
   standard deviation (ddof 1); (c) the leave-one-cluster-out mean, minimised over clusters, is at least
   PASS_LOO_MIN_MEAN = +0.01 (given (a) and (b) this always holds, whatever the number of clusters: a leave-one-out mean
   below 0.01 needs one value far above the rest, and that spread also pushes the t bound below zero, so (c) is a
   reported check and not an extra protection); (d) the number of clusters is at least MIN_CLUSTERS = 10; (e) per trial,
   among the pairs that passed checks (s1) and (s2) of rule 2 and did not fail (s4) (a pair with a missing archive day
   counts as not failing it), the share excluded by (s3) or (s5) is at most MAX_EXCLUDED_SHARE = 10%. Clauses (d) and
   (e) are the lead's additions to the plan's kill line, and (c) is implied by (a) and (b) (mean net not below -2%,
   interval includes zero, or the fall is all inside the first minute). The third clause of the plan is enforced by
   construction: no price before the entry minute is part of any result. Passing none of the trials is a result: the
   idea is closed for tier 2 and no part of it is rerun with other settings. A class T pass is in-sample, because the
   events generated the hypothesis: it shows that the effect survives execution cost, funding and the stop, not that an
   edge exists, and it does not move the tier 2 prior beyond what forward events show. A trial that passes reaches gate
   G0 of the tier 2 plan only if (i) its delay profile (rule 10) has a mean of at least +0.02 at LIVE_DELAY_MINUTES = 6
   after m0 (the delay-d statistic is the full trial of rules 3 to 8 with ENTRY_DELAY_MINUTES replaced by d and te =
   entry + h, over the pairs the trial priced successfully, a pair that fails a check at the later entry minute dropping
   out of that delay only), the delay that a 5-minute recorder plus one minute of work can sustain, or (ii) the owner
   accepts, at G0, a recorder whose measured 95th percentile of stamp-to-order latency is under 60 seconds.

10. REPORTED, NOT JUDGED (descriptive, no trial, cannot rescue a failed trial). For every trial and class: counts of
    announcements, tokens, tokens with a symbol, eligible tokens and clusters, with exclusion reasons and the by-year
    reconciliation with the preprint's Table 1; the mean, median, standard deviation, share positive and t of cluster
    values (net, gross, unhedged net, doubled-slippage net); the result by calendar year; the entry delay profile at
    DELAY_PROFILE_MINUTES = (1, 3, 6, 10, 30) after m0; the worst adverse excursion per token (maximum high over the
    bars from the entry bar up to, not including, the bar at te, which the stop does not shorten) with the number of
    tokens whose excursion reached +30% (stopped) and +90% (a proxy for liquidation of a 1x isolated short); the
    realised funding sum; the number of truncated, stopped and btc_carried trades, and of trades flagged funding_gap (a
    descriptive flag: it also marks a truncated trade, which has no settlement after its exit, and a funding interval
    that changes inside the hold); per pair, the first futures delisting notice in the record (symbols from titles and
    bodies) that names the symbol between the stamp and te, if any; the share of class D tokens that were in class T
    earlier and their results apart from the rest; the days between a class D token's first tag and its delisting
    notice, and between its latest tag before that notice and the notice.

11. THE CLAIM LINE (tier 1, not part of the 4 trials, after a pass of a class T trial only). A pass makes no claim that
    the announcement caused the fall. Two nulls are specified here and are implemented in a separate lock folder
    (horizon/e1n, zero trials, so this digest does not change), whose definitions are frozen here, so its implementation
    has no discretion: its code and fetch plan are written after a pass, reviewed by an Opus gate against this text, and
    registered in a second anchor (its own digest and this lock's digest) before it is run, and both results go to the
    owner whatever it shows: (i) placebo days: the same tokens at the same clock time of day on the days 35, 28, 21, 14
    and 7 days before the event day, with the identical rule, dropping any placebo day that falls inside the 30 days
    after any notice in the record that names the token, the excess being event value minus placebo value per cluster;
    (ii) matched controls: for each eligible token, the 3 USDT-M perps that have no notice at or before the stamp (known
    at the stamp, never conditioned on what happens later) and are not in the same notice, with a perp listed 30 days or
    more before the stamp, nearest in ln(quote volume of the 1,440 minutes before the stamp), the same rule applied to
    them at the same stamp. The claim stands only if both excess intervals (the same bootstrap, one-sided level 0.05)
    are above zero.

12. FORWARD RECORD. Events with a stamp at or after FREEZE_MS are never read by this lock. They are the confirmation
    sample. The announcement recorder (unit 1 of the implementation map) stamps them at receipt. A forward judgement is
    made only under a later lock (lab-v5 or similar) signed by the owner. The fetch plan of this lock lists only days
    inside each symbol's archive span, so a forward contract whose archive ends inside its window needs that later lock
    to handle the days after its end.

13. DATA AND GUARDS. Bars: Binance USDT-M perpetual daily 1m kline files (fetched by scripts/ops/fetch-event-files.ts
    into gzip CSV with the header
    open_time,open,high,low,close,volume,quote_volume,trades,taker_buy_base,taker_buy_quote) for the days stamp day - 1
    to stamp day + 2 of every token with a symbol in the record and for BTCUSDT on the same days. Funding: monthly
    funding files for each used symbol over the months touched by [stamp day - 1, stamp day + 2]. All reads go through
    horizon/e1/data.py and nothing dated after HARD_LAST_DATE is ever read (no override). A file's sha256 is recorded in
    the result. A bar row outside its file's day, or a duplicate open_time, is an error.

14. WHAT IS NOT DONE. No parameter (delay, exit, stop, hedge, cost) is tuned. No other event class is tested here
    (futures delisting notices, seed tags, new listings, unlocks, tag removals are parked). No result is read before the
    digest, the event record, the plan and the manifest are registered and the owner has signed. The ledger gets 4
    trials for this id, and the total becomes 4,491.

PREDICTION (registered before any run, also the constant PREDICTION below): "Registered 2026-11-14 by the lead before
any return was computed: class T at 24 hours passes with probability about 0.25 and class T at 4 hours about 0.15. Each
class D trial passes with probability about 0.07. At least one of the four trials passes with probability about 0.3.
Where a trial fails, the most likely cause is clause (b), a bound that cannot clear zero with about 25 clusters, and not
a negative mean."
"""

from __future__ import annotations

import datetime as dt
import functools
import hashlib
from pathlib import Path

LEDGER_ID = "horizon-e1"

PREDICTION = (
    "Registered 2026-11-14 by the lead before any return was computed: class T at 24 hours passes with probability "
    "about 0.25 and class T at 4 hours about 0.15. Each class D trial passes with probability about 0.07. At least one "
    "of the four trials passes with probability about 0.3. Where a trial fails, the most likely cause is clause (b), a "
    "bound that cannot clear zero with about 25 clusters, and not a negative mean."
)

CLASS_T = "T"
CLASS_D = "D"
CLASSES = (CLASS_T, CLASS_D)
HORIZONS_HOURS = (4, 24)
TRIAL_IDS = tuple(f"{cls}-{h}h" for cls in CLASSES for h in HORIZONS_HOURS)
TRIALS = len(TRIAL_IDS)

MINUTE_MS = 60_000
HOUR_MS = 3_600_000
DAY_MS = 86_400_000

EVENTS_FROM_MS = int(dt.datetime(2022, 1, 1, tzinfo=dt.UTC).timestamp() * 1000)
FREEZE_DATE = dt.date(2026, 11, 13)
FREEZE_MS = int(dt.datetime(2026, 11, 13, tzinfo=dt.UTC).timestamp() * 1000)
HARD_LAST_DATE = dt.date(2026, 11, 12)  # no price file of a later day is ever read

ENTRY_DELAY_MINUTES = 1
DELAY_PROFILE_MINUTES = (1, 3, 6, 10, 30)
LIVE_DELAY_MINUTES = 6  # a 5-minute poll plus one minute of work
STALE_EXIT_MINUTES = 30
FUNDING_GAP_SLACK_MINUTES = 1
STOP_ADVERSE = 0.30
LIQUIDATION_PROXY_ADVERSE = 0.90

TAKER_FEE_BPS = 5.0
SLIP_TOKEN_FLOOR_BPS = 10.0
SLIP_TOKEN_RANGE_SHARE = 0.25
SLIP_BTC_BPS = 1.0
SLIP_STRESS_MULT = 2.0

MIN_LISTED_DAYS_BEFORE_STAMP = 1  # applied by scan_events.py when it picks the symbol
ACTIVITY_WINDOW_MINUTES = 1_440
ACTIVITY_MIN_TRADED_MINUTES = 360
MAX_EXCLUDED_SHARE = 0.10

CLUSTER_GAP_HOURS = 24
BOOT_RESAMPLES = 10_000
BOOT_SEED = 20_261_114
TRIAL_ALPHA = 0.05 / TRIALS
PASS_MIN_MEAN = 0.02
PASS_LOO_MIN_MEAN = 0.01
MIN_CLUSTERS = 10

EVENTS_RECORD = "scripts/research/py/records/horizon_e1_events.json"
EVENTS_SHA256 = "41009340d52315e833dbc7c0b89bdbd91bea9a8bf661b038a55ba8e91b141d89"  # sha256 of that file
# Table 1 of the preprint, Panel A: year -> (announcements, first-time tags after its drops).
PREPRINT_TABLE1 = {2023: (2, 23), 2024: (4, 30), 2025: (8, 41), 2026: (12, 61)}
REGISTRATION_ANCHOR = "scripts/research/py/records/horizon_e1_registration.json"

__all__ = [
    "CLASSES",
    "LEDGER_ID",
    "PREDICTION",
    "TRIALS",
    "TRIAL_IDS",
]


@functools.lru_cache(maxsize=1)
def lock_digest() -> str:
    """sha256 over the bytes of every horizon/e1/*.py file, sorted by name (this file included).

    The code is part of the lock: any edit of any of these files changes the digest.
    """
    h = hashlib.sha256()
    for path in sorted(Path(__file__).resolve().parent.glob("*.py"), key=lambda p: p.name):
        h.update(path.name.encode() + b"\0")
        h.update(path.read_bytes())
        h.update(b"\0")
    return h.hexdigest()
