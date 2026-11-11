"""LIGHTER STAGE 2 LOCK (ledger id lighter-l1): intraday rules on Lighter perpetuals, a declared grid of 2,064
configurations. Registered 2026-11-11 by the lead. This module IS the specification. Nothing was run on real data
before this text and the code that follows it were written, and nothing may be changed after the first real run.
Lighter's standard account pays zero fees, but its taker orders are delayed 300 ms, so the study prices every fill
from the per-minute fold of the public trade archive (lighter/fold_trades.py), never from a mid.

CODE IS PART OF THE LOCK. lock_digest() is the sha256 of the bytes of every lighter/*.py file (sorted by name,
fold_trades.py and fetch_funding.py included, this file included). Every result file records that digest and the git
HEAD commit. Any change to a lighter/*.py file after the first real run changes the lock digest, gets a new ledger id,
and its trials are added to the ledger. The commands dev, null, report, confirm and eligibility refuse to run when the
git working tree has uncommitted changes under scripts/research/py/lighter, unless the fold directory holds a marker
file named SYNTHETIC (written by lighter/synthetic.py) AND markets.json carries "source": "synthetic" AND no entry of
the fold manifest has a source_url starting with https (the marker alone never disables a guard): such a run writes
"synthetic": true into its results, and report and confirm refuse to mix synthetic and non-synthetic files. Every
result also records the numpy, pandas and pyarrow versions. When git is not available (the research image has no
.git) the commit and a clean-tree attestation are taken from the environment variables LIGHTER_GIT_HEAD and
LIGHTER_TREE_CLEAN=1 and the result says "attested by environment"; when git is available it is checked directly. The
digest over the file bytes is what binds the code, the commit id is a label.

REGISTRATION ANCHOR. scripts/research/py/records/lighter_l1_registration.json (outside lighter/, written by the lead at
registration) holds the lock digest and the sha256 of the fold manifest.jsonl, of markets.json and of the funding
manifest, and a sorted listing (name, size) of the Binance files. The command register-check prints what the file
should contain for given data directories. dev, null, report and confirm refuse to run on non-synthetic data when the
file is absent or anything differs. (eligibility and scalescan do not need it: they run before registration.)

DATA (every read goes through lighter/data.py, which enforces the span guards)
- Fold: <fold>/v1/date=YYYY-MM-DD.parquet, one row per (market_id, UTC minute), the fold manifest
  <fold>/manifest.jsonl and the market list <fold>/markets.json (markets_file_version 2, static fields only). Prices
  are raw integers, real price = raw / 10^supported_price_decimals. FILL_DELAY_MS = 500 is imported from fold_trades.
- Binance 1m bars: <dir>/<SYMBOL>/<SYMBOL>-1m-YYYY-MM.csv.gz (open_time, open, high, low, close, volume,
  quote_volume, trades, taker_buy_base, taker_buy_quote). A row outside its file's month or a duplicate open_time is an
  error.
- Funding: one Parquet per market, timestamp (unix seconds) and rate_long_pays (fraction per hour, positive when
  longs pay).
- There is no universe file. The point-in-time universe below replaces it: choosing markets from late 2026 data
  (open interest, today's spread) and backtesting them over 2025 to 2026 would be survivorship, because the markets
  that are cheap today are the ones that grew. Eligibility and tiers come from the fold itself, month by month, from
  the previous month's rows only.

MARKET LIST AND CLASSES. Markets are the perp entries of the fold's markets.json (market_type "perp"), identified by
market_id, with symbol and supported_price_decimals from that file. Three explicit tuples, fixed on 2026-11-11 from
symbols alone, before any return was computed: CRYPTO_SYMBOLS, TRADFI_SYMBOLS, UNCLASSIFIED_SYMBOLS. A perp symbol found
in none of the three, or in more than one, stops every command with the symbol named. F2 baskets are the eligible
markets of the same class, CRYPTO or TRADFI. An UNCLASSIFIED market gets no F2 signal and is in no basket. F3 applies
to CRYPTO markets other than BTC. F1, F4, F5 and F6 apply to every market. BTC for family F3 is the market whose symbol
is exactly "BTC". Every market_id present in the fold is listed in the output. A market_id that is absent from
markets.json and meets the activity clause in any month stops the command with its id named.

MONTHLY ELIGIBILITY. For each calendar month M from 2025-07 to 2026-10 and each market, computed ONLY from fold rows of
the previous calendar month P = M - 1 (eligibility reads fold cost and activity fields of P only: n_trades,
last_buy_px, last_buy_ts, last_sell_px, last_sell_ts):
- activity: the median over every calendar day of P (0 for a day with no rows) of the day's sum of n_trades must be at
  least 5,000.
- spread proxy: over the minutes of P in which both last_buy_px and last_sell_px exist and |last_buy_ts - last_sell_ts|
  <= 2,000 ms, take x = (last_buy_px - last_sell_px) / ((last_buy_px + last_sell_px) / 2) in bps. At least 1,000 such
  minutes are required. spread_proxy = max(0, median of x).
- tier: "A" when spread_proxy <= 1.0, "B" when it is above 1.0 and at most 2.5, otherwise not eligible in M.
A market may OPEN a trade at decision time g only if it is eligible in the month containing g. An open trade exits by
the normal rules even if the exit falls in a month where the market is not eligible. Universe "A" = tier A markets of
that month, universe "AB" = tier A or B markets of that month. There is no per-market development start. Eligibility
computes no signal and no return, so the eligibility command may be run before registration.

SPANS
- Development: 2025-07-01 to 2026-06-30 for every market, plus the trailing WARMUP_DAYS = 2 days before the start that
  the features need. Confirmation: 2026-07-01 to 2026-10-31 with the same warm-up. Eligibility for 2026-07 uses June
  2026 rows, which confirm may read as warm-up.
- Nothing from 2026-11-01 onward is ever read (hard guard in data.py, no override). The dev, null and eligibility
  commands can read only up to 2026-06-30 (eligibility may go through confirm only with a finalists file).

BINANCE SYMBOL. BINANCE_MAP is a literal dict in this file: every symbol of the three tuples maps to symbol + "USDT",
except HYUNDAIUSD SAMSUNGUSD SKHYNIXUSD US100 US10Y US500 TUR30 USDHKD USDKRW, which map to None (no Binance
counterpart assumed).

CLOCK. Decision times g are the 5-minute UTC boundaries. A feature at g uses only Binance 1m bars with open_time at
most g - 60 s and fold rows of minutes at most g - 60 s (the minute that starts at g - 60 s is the last one used).

PRICES FOR SIGNALS
- Lighter mid proxy of minute m: (last_buy_px + last_sell_px) / 2 when both exist in that minute, else last_px, else
  carried forward from the previous minute. Staleness (minutes since the last real value) is tracked.
- Signal price source, per market and month M: "binance" only if (1) BINANCE_MAP gives a symbol, (2) Binance 1m files
  exist for both month P = M - 1 and month M (the market was listed on Binance by the start of M; existence check
  only), and (3) the SOURCE GUARD below passes. Otherwise "lighter". Every feature for a decision in month M uses that
  month's source for its whole trailing window (the warm-up reads month P from the same source). F4's Binance input and
  all of F5 exist only in months whose source is "binance".
- SOURCE GUARD, computed on month P only (so it is point in time): over the 5m grid points of P where both the Lighter
  5m close and the Binance 5m close are valid, |median of ln(Lighter close / Binance close)| <= 50 bps AND the Pearson
  correlation of the two series of 15 minute log returns (non-overlapping windows where both closes are valid, at
  least 1,000 such points) is >= 0.5. It protects against a ticker that means a different asset on Binance. It reads
  Binance file content, so dev, null, report and confirm compute it (cached in the dev result). The eligibility command
  reports file existence only, and says "source pending guard" for a month whose files exist.
- 5m close at g: Binance = close of the 1m bar with open_time g - 60 s, valid only if all five 1m bars of the five
  minutes exist. Lighter = mid proxy of minute g - 60 s, valid only if at least one trade print (last_px present) fell
  in the five minutes.
- Price-scale guard: a scale break is a jump between two consecutive PRINTED minutes of the mid proxy with
  |ln(ratio) - k ln 10| < 0.05 for an integer k != 0, AND the new level holds: the median mid proxy of the next 60
  printed minutes (the jump minute included) is within 0.05 (in ln) of the post-jump level. Read as a level shift: the
  median of the previous 60 printed minutes must likewise sit within 0.05 of the pre-jump level (so the return from a
  crash minute is no rescaling), and each window needs at least 30 printed minutes (a listing minute or the end of the
  data cannot be confirmed). Only that stops a command,
  with the market and the minute named; a crash or a listing minute that does not hold is only listed.
  KNOWN_SCALE_BREAKS
  (empty) is frozen from the output of the scalescan command at registration. scalescan reads mid proxy inputs
  (last_px, last_buy_px, last_sell_px) of the development span only, computes no signal and no strategy return, may be
  run before registration and writes scale_breaks.json with every candidate jump (market, minute, ln ratio, whether it
  holds).

INPUTS
- r_k(g) = ln(close5(g) / close5(g - 5k min)), valid when both closes are valid.
- sigma(g) = sample sd (ddof 1) of the 288 5m log returns r_1 ending at g, requiring at least 260 valid.
- z_k = r_k / (sigma x sqrt(k)).

FAMILIES (signal configurations, 57 plus 6)
- F1 own reversal: side = -sign(z_k) when |z_k| >= theta. k in (1, 3, 12), theta in (1.0, 1.5, 2.0). 9.
- F2 basket-residual reversal: as F1 on r_k minus the equal-weight mean r_k of the OTHER eligible markets of the same
  class and universe in the month (at least 3 others with a valid r_k, else no signal). The z is residual_k / (sd_res x
  sqrt(k)) where sd_res is the sample sd of the residual's own 288 trailing 5m values (the k = 1 residual, same window
  and 260 minimum as sigma). 9 (computed per month and universe).
- F3 leader continuation: crypto markets other than BTC only. side = sign(z_k of BTC) when |z_k of BTC| >= theta. BTC
  must belong to the universe that month, else the family has no signal there. 9.
- F4 flow imbalance: I = (B - S) / (B + S) over the last k 5m bars, B + S > 0. Three inputs: "binance" (B =
  taker_buy_quote, S = quote_volume - taker_buy_quote, needs all minutes, months with source binance only), "small"
  (lt_1k bands) and "large" (10k_100k plus ge_100k bands). Reference = the values of I at the previous 288 grid points
  strictly before g (at least 260 valid). Upper trigger: I >= the q quantile of the reference (numpy linear). Lower
  trigger: I <= the (1 - q) quantile. "follow": long on upper, short on lower. "fade": the opposite. k in (3, 12), q
  in (0.8, 0.9). 3 x 2 x 2 x 2 = 24. The realised trigger rate of each configuration (the share of valid grid points
  that fire) is reported.
- F5 venue gap (months with source binance only): L = Lighter mid proxy of minute g - 60 s, requiring the last trade
  print of that minute to have a timestamp in [g - 10 s, g - 0.5 s). P = Binance 1m close of the bar with open_time
  g - 60 s. dev = ln(L / P) minus the median of ln(L / P) over the previous 288 grid points (at least 200 valid), in
  bps. side = -sign(dev) when |dev| >= theta, theta in (2, 4, 8) bps. Variant "persist" also needs the same condition
  with the same sign one minute earlier (minute g - 120 s, the same print-window rule shifted by one minute, same
  median). 3 x 2 = 6.
- F6 funding capture: only at g with minute-of-hour 55. f = rate_long_pays of the settlement stamped at minute 0 of g's
  hour (if that row is missing, no signal), in bps per hour. theta in (1, 2, 4). f >= theta: short. f <= -theta: long.
  Time exit at g + 10 min or g + 20 min. 3 x 2 = 6 complete configurations apart from the universe.

GRID. F1 to F5: 57 signal configurations x holds (5, 15, 30, 60, 120, 240 minutes) x exits ("time", "stop2_target2",
"target1") x universes ("A", "AB") = 2,052. F6: 6 x 2 universes = 12. Total 2,064, enumerated in the order of GRID
below with stable ids.

FILLS (entries and exits alike)
- A taker order of side s sent at minute boundary t fills at the first Lighter trade print of EITHER side with
  timestamp at or after t + 500 ms. An ENTRY searches minute t only (the earlier of first_buy_ts and first_sell_ts of
  that minute's row, which are by construction at or after t + 500 ms): with no print of either side at or after
  t + 500 ms in minute t it is unfilled (no trade, counted). An EXIT searches minute t first and then minutes t + 1 to
  t + 15 in order (16 minutes). If the print is of side s (a taker-buy print for a buy order, a taker-sell print for a
  sell order) the fill price is the print price. If it is of the other side, the fill price is the print price moved
  against the order by sp_fill: a buy fills at sell_print_px x (1 + sp_fill / 10,000), a sell at buy_print_px x
  (1 - sp_fill / 10,000).
- sp_fill(t') for a fill found in minute t' is max(sp, x(t'), x(t' - 1 minute)) where sp is the MONTHLY ELIGIBILITY
  spread proxy (bps) of the month containing the order's boundary t (if the market is not eligible that month, which can
  happen for an exit, the latest month in which it had a proxy; before the first month with a proxy there is none and
  such minutes cannot carry a fill), and x(m) = (last_buy_px - last_sell_px) / ((last_buy_px + last_sell_px) / 2) in bps
  when both exist in minute m and |last_buy_ts - last_sell_ts| <= 2,000 ms (the pair rule of the eligibility proxy),
  else undefined. Negative x counts as 0. x is used only to price a fill, never a decision, and taking the maximum can
  only raise the cost. The historical cost model has no order book and is known to understate the spread at event
  times. The doubled-spread condition is the binding one. The forward tape, which records the real book, is the
  measurement of this cost.
- If both first prints of a minute have the same timestamp, the fill is the WORSE of the two candidate prices for the
  order: the same-side print price against the adjusted opposite-side price. The tie share is reported per
  configuration.
- An exit with no print in the 16 minutes fills at the mid proxy of minute t + 15 moved against the order by sp_fill / 2
  (t' = t + 15), stamped at the end of minute t + 15, and is flagged. A long entry and a short exit are buy orders, a
  short entry and a long exit are sell orders. (Waiting for a same-side print would fill each leg late exactly when
  waiting helps, because trade signs persist: it is not used.) The spread sensitivity run doubles sp_fill.
- Zero fees. One open position per (configuration, market): an entry at g is allowed only if the previous trade's exit
  fill timestamp is at or before g. An entry whose data (entry and exit windows) would pass the span end is not a
  candidate.

EXITS. Time: e = g + hold. With sigma_H = sigma(g) x sqrt(hold / 5 min), "stop2_target2" and "target1" look at every
minute boundary t with g < t < g + hold: mark = mid proxy of minute t - 60 s, u =
side x ln(mark / entry fill price). stop2_target2 decides at the first t with u <= -2 sigma_H or u >= 2 sigma_H.
target1 decides at the first t with u >= sigma_H. Otherwise e = g + hold. A candidate without a valid sigma(g) cannot be
evaluated by these two exits and is counted as no_sigma.

RETURNS. net = side x ln(exit price / entry price) - sum over funding settlements s with entry fill timestamp < s <=
exit fill timestamp of side x rate_long_pays(s). Settlements are the UTC hour boundaries. A missing settlement row
counts as 0 and increments a counter. Equal notional per trade.

FUNDING SIGN AND STAMP. The reading "direction names the paying side" (so rate_long_pays is a cost to longs when
positive) was checked on 2026-11-11 against the hourly venue recorder: over Lighter rows whose hourly rate was at least
2e-5 in size, the rate signed that way had the sign of the mark-minus-index premium in 155 of 170 rows (the rest of the
rows sit at the 0.0012% baseline, where the premium sign carries no information). It is still to be checked against a
realised payment before any live use. A funding row stamped t is treated as the
payment made at t for the hour ending at t. Evidence: rows stamped 07:00 UTC on 2026-11-11 were visible at 07:50 and
unchanged at 09:16, rows for 08:00 and 09:00 appeared afterwards, and the venue's documentation says payments occur at
each hour mark from the premium of the last hour. Not excluded: the rate being fixed at t and paid at t + 1 hour. Under
that reading F6's signal is the rate actually paid and every funding charge is one hour late. A realised payment settles
it (the fill probe). An F6 finalist cannot go forward before that check. FUNDING_STAMP_VERIFIED is False until the lead
flips it at registration, and dev refuses to run on non-synthetic data while it is False.

STATISTICS. Daily series: for every configuration, every UTC day from 2025-07-01 (dev) or 2026-07-01 (confirm) to the
span end, the sum of net over trades whose exit fill timestamp falls on that day (0 on days with no exit). t = mean /
standard error with Newey-West, Bartlett kernel, 5 lags. Also: trades, mean net per trade in bps, entries per hour
pooled (trades / hours in the series), unfilled count, flagged exits, share of positive calendar months (months with
at least one trade, by exit day), share of positive markets among markets with at least 100 trades, the counters of
missing settlements and settlements crossed, and all of it again split by signal price source (binance, lighter).

NOISE CONTROL. Two sets of 20 runs.
- Shift runs: the offsets are 20 DISTINCT values, numpy.random.default_rng(20261111).choice(numpy.arange(7, 61),
  size=20, replace=False), and run i (seed i, 1 to 20) uses the i-th. Run i shifts the decision array (the side per g)
  of EVERY market and every F1 to F5 configuration by that many days, circularly within the fixed span (np.roll), the
  same for every market. The array shifted is the real run's decision array before eligibility masking (for F2 and F3
  the months in which the market and enough basket members exist), and after the shift a decision still requires the
  market to be eligible, in the right tier, in the month containing the shifted time. The F5 and F4-binance decision
  arrays are zero outside the months whose source guard passed even before the shift (as the F2 and F3 arrays are zero
  outside the months in which the market is a basket member). Prices, fills, exits and funding are not shifted.
  NOISE_BAR = the LARGEST of the 20 maxima of the daily t over the F1 to F5 configurations.
- F6 sign-flip runs: F6 is judged separately. In run i (seed i) every F6 decision is multiplied by an independent fair
  random sign drawn from numpy default_rng([20261111, i]) (arrays drawn per market, in market id order, per F6 signal in
  id order). F6_BAR = the LARGEST of the 20 maxima of the daily t over the 12 F6 configurations.

DEVELOPMENT PASS, all required: (a) mean net per trade > 0, (b) daily t >= max(3.0, bar) where bar is NOISE_BAR for F1
to F5 and F6_BAR for F6, (c) trades in at least 6 calendar months and at least 70% of those months positive, (d) at
least 5 markets with 100 or more trades and at least 60% of them positive, (e) at least 2,000 trades, (f) flagged exits
at most 1% of the configuration's trades. Class "desk" if entries per hour pooled >= 10, else "slow".

FINALISTS. At most 3. Candidates are the configurations that pass items (a) to (f), are not SUSPECT (see TRIPWIRE)
unless listed in the audit file (see TRIPWIRE), and meet all registered conditions:
- MIRROR DIAGNOSTIC (cost-adjusted): the configuration is also run with every side multiplied by -1. With mean(cfg)
  and mean(mirror) the mean net per trade of the two runs, (mean(cfg) - mean(mirror)) / 2 must exceed the mean over the
  configuration's trades of (sp_fill at entry + sp_fill at exit) / 2, both sides in the same units (bps, i.e. log
  return x 10,000). Both numbers are recorded, with the two means.
- SOURCE: the mean net per trade is > 0 within the signal price source (binance or lighter) that carried the majority
  of the configuration's development trades.
- SPREAD SENSITIVITY: the configuration is re-run with sp_fill doubled in the fill rule (every use of it).
  Mean net per trade under the doubled proxy must be > 0 too.
- FUNDING COVERAGE: the missing-settlement counter is at most 1% of the settlements its trades crossed.
For each family take the candidate with the highest daily t, restricted to class desk when any desk candidate of that
family exists. Rank those family bests by daily t and keep the top 3. Written to finalists.json (may be empty).

CONFIRMATION PASS: mean net per trade > 0, at least 3 of the 4 calendar months (July to October 2026) positive, the
mirror diagnostic, the spread sensitivity and the source condition above on the confirmation data (the source being the
development majority source), and Holm at family level 0.05 on the
one-sided p values (normal, from the daily-series t): with F finalists ordered by p, the smallest p must be < 0.05 / F,
the next < 0.05 / (F - 1), and so on, stopping at the first failure.
CONFIRM INTEGRITY (two steps). `confirm --prepare` takes --dev-dir (the dev result and the 20 + 20 null result
files), checks every file's lock digest and content hash (finalists file included), recomputes the finalists itself
(re-running the mirror and doubled-spread variants on the development data), refuses when they differ from the supplied
finalists file, writes scripts/research/py/records/confirm_record.json (lock digest, finalists, the content hashes of
the
dev and null files, "ran": false) and stops. `confirm --run` requires that record to be committed (git: tracked and
unmodified at HEAD; where git is unavailable, LIGHTER_RECORD_COMMITTED=1), refuses when a confirm result already
exists in the out dir or the record says it ran, re-runs each finalist on the development data first (stopping on any
difference from the dev result), marks the record consumed (records/confirm_ran_<digest>.json) and then runs the
confirmation. Null runs with no maximum (None) are an error.

TRIPWIRE. Any configuration with mean net above 5 bps a trade or daily t above 8 is marked SUSPECT in the report, and
the report says to audit for look-ahead before anything else. A SUSPECT configuration cannot be a finalist until an
audit note is committed and its id is listed in scripts/research/py/records/lighter_l1_suspect_cleared.json (a list of
configuration ids with a note each; absent means empty). The file lives outside lighter/ because editing a lock constant
would change the digest. report reads it and records its sha256, and confirm checks the same hash.

ACCOUNT LAYER (report only, finalists only): start 100 USD, leverage L in (3, 10, 20), at most 10 concurrent
positions, notional per entry = max(10, equity x L / 10) USD, an entry is skipped when 10 positions are open or
equity x L / 10 < 10, equity marked each minute with the mid proxy, the account is liquidated when equity <= 1.2% of
gross open notional. Reported: final equity, minimum equity, entries skipped, liquidated yes or no.

READINGS OF AMBIGUOUS TEXT (each is the most literal reading, or the lead's ruling where one was made)
1. r_k needs only the two end closes to be valid, not the closes between them.
2. A Lighter 5m bar is valid when any of its five minutes has last_px present (a trade, not a liquidation). Its close
   is the mid proxy of minute g - 60 s.
3. F2: sd_res is the sd of the k = 1 residual series, and the z keeps the sqrt(k) factor of F1.
4. F4: the binance input needs all minutes of the window to exist, the Lighter inputs treat a missing fold row as zero
   flow, a decision with both triggers true has no signal, and the reference needs the full 288 prior grid points.
5. F5: the print window uses max(last_buy_ts, last_sell_ts) of the minute, which is the last trade print.
6. F6: only the settlement stamped at minute 0 of g's hour is used, whatever the rate.
7. F6: a trade's signal is the previous hour's settled rate, and the trade collects or pays the next settlement.
8. The first stop/target mark is the mid proxy of the entry minute, and a mark may
   be a stale carried-forward value.
9. A candidate whose entry and exit windows pass the span end is not a candidate. A candidate without a valid sigma(g)
   cannot be evaluated by the stop/target exits: it is counted as no_sigma and does not hold the position.
10. Entries per hour pooled = trades / (24 x days of the configuration's daily series).
11. Positive months are counted by exit month, over months with at least one trade, partial months included.
12. A shift by D days of a span shorter than D days wraps (np.roll semantics).
13. Finalists: the best candidate of each family (desk first), then the top three by daily t.
14. confirm recomputes eligibility, tiers, sources and finalists from the data and the dev directory.
15. The account layer charges the trade's realised funding at the exit, uses simple returns, floors a liquidated equity
    at 0, and processes exits before entries within a minute.
16. dev writes no trade lists unless --save-trades is given (hundreds of millions of rows). The report re-runs the
    finalists, writes their trade lists and stops if the re-run differs from the development statistics or the
    eligibility differs.
17. F5 compares the Lighter price scaled by supported_price_decimals with the Binance close as is. A contract quoted per
    1000 units (1000PEPE against 1000PEPEUSDT) is on the same scale.
18. Source per month: the own-market features are computed over the whole span once per source and the decision at g
    takes the set of the month's source. F2 and F3 are recomputed per month with each member's source of that month. A
    month on Binance needs the files of both M and P and a passing guard.
19. Eligibility gates only the opening of a trade. The one-position rule, the exit and the funding are unchanged for a
    trade that is open when its market stops being eligible.
20. Spread proxy: x = (last_buy_px - last_sell_px) x 10,000 / ((last_buy_px + last_sell_px) / 2) on the raw integer
    prices (scale free), over minutes with both prints at most 2,000 ms apart. The activity median counts each calendar
    day of P, 0 for a day without rows. A market has a spread proxy in a month when it has at least 1,000 such minutes,
    whatever its activity.
21. A configuration with no eligible market still has a zero daily series, so its t is 0 and its mean net per trade is
    undefined.
22. A configuration's F2 statistics are also split by asset class (crypto, tradfi).
23. The fill rule's month proxy is the proxy of the month containing the order boundary, carried forward from the latest
    earlier month that had one; before the first month with a proxy there is none and the minute cannot carry a fill.
    The spread sensitivity doubles sp_fill in the fill and in the fallback.
24. The Holm family is the set of finalists, and the source guard uses grid points where both 5m closes are valid (the
    level clause) and non-overlapping 15 minute windows (the correlation clause).
25. Cost-adjusted mirror: the cost is the mean over the configuration's trades of (sp_fill at entry + sp_fill at exit)
    / 2, evaluated for every fill including those priced by a same-side print.

PREDICTION (registered before any run, also the constant PREDICTION below): "Registered 2026-11-11 by the lead before
any run: no finalist passes the confirmation slice. Most likely no configuration passes development item (b)."
"""

from __future__ import annotations

import datetime as dt
import functools
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from lighter.fold_trades import FILL_DELAY_MS

PREDICTION = (
    "Registered 2026-11-11 by the lead before any run: no finalist passes the confirmation slice. "
    "Most likely no configuration passes development item (b)."
)
LEDGER_ID = "lighter-l1"

__all__ = [
    "FILL_DELAY_MS",
    "GRID",
    "LEDGER_ID",
    "PREDICTION",
    "TRIALS",
]

MINUTE_MS = 60_000
GRID_MS = 300_000
HOUR_MS = 3_600_000
DAY_MS = 86_400_000
GRID_PER_DAY = 288

# Spans.
DEV_FIRST_DATE = dt.date(2025, 7, 1)
DEV_LAST_DATE = dt.date(2026, 6, 30)
CONFIRM_FIRST_DATE = dt.date(2026, 7, 1)
CONFIRM_LAST_DATE = dt.date(2026, 10, 31)
HARD_LAST_DATE = dt.date(2026, 10, 31)  # nothing later is ever read
WARMUP_DAYS = 2
CONFIRM_MONTHS = ((2026, 7), (2026, 8), (2026, 9), (2026, 10))

# Monthly eligibility (computed from the previous month's fold rows only).
ELIG_MIN_MEDIAN_TRADES = 5_000
ELIG_MIN_QUALIFYING_MINUTES = 1_000
ELIG_MAX_TS_GAP_MS = 2_000
TIER_A_MAX_BPS = 1.0
TIER_B_MAX_BPS = 2.5
# ISO dates of fold days known to be absent upstream. Empty: any absent day stops the command.
KNOWN_MISSING_FOLD_DAYS: tuple[str, ...] = ()
# (symbol, minute start in ms) pairs where a price-scale break is known and accepted. Empty.
KNOWN_SCALE_BREAKS: tuple[tuple[str, int], ...] = ()
SCALE_BREAK_TOL = 0.05
SCALE_HOLD_MINUTES = 60
SCALE_MIN_WINDOW = 30

# To be flipped by the lead at registration, after the funding stamp is re-checked (see FUNDING SIGN AND STAMP).
FUNDING_STAMP_VERIFIED = False

# Source guard (month P only).
GUARD_MAX_MEDIAN_BPS = 50.0
GUARD_MIN_CORR = 0.5
GUARD_MIN_POINTS = 1_000

# Fixed on 2026-11-11 from symbols alone, before any return was computed.
CRYPTO_SYMBOLS: tuple[str, ...] = (
    "0G",
    "1000BONK",
    "1000FLOKI",
    "1000NOT",
    "1000PEPE",
    "1000SHIB",
    "1000TOSHI",
    "2Z",
    "AAVE",
    "ADA",
    "ADI",
    "AERO",
    "AI",
    "AI16Z",
    "ANSEM",
    "APEX",
    "APT",
    "ARB",
    "ARC",
    "ASTER",
    "AVAX",
    "AVNT",
    "AXS",
    "AZTEC",
    "BCH",
    "BERA",
    "BIO",
    "BIRB",
    "BNB",
    "BTC",
    "CASHCAT",
    "CRO",
    "CRV",
    "DASH",
    "DOGE",
    "DOT",
    "DRV",
    "DUSK",
    "DYDX",
    "EDGE",
    "EIGEN",
    "ENA",
    "ETH",
    "ETHFI",
    "FARTCOIN",
    "FF",
    "FIL",
    "FOLKS",
    "GMX",
    "GRAM",
    "GRASS",
    "HBAR",
    "HYPE",
    "ICP",
    "JTO",
    "JUP",
    "KAITO",
    "LAUNCHCOIN",
    "LDO",
    "LINEA",
    "LINK",
    "LIT",
    "LTC",
    "MET",
    "MNT",
    "MON",
    "MORPHO",
    "NEAR",
    "NMR",
    "ONDO",
    "OP",
    "PENDLE",
    "PENGU",
    "PIPPIN",
    "POL",
    "PONS",
    "POPCAT",
    "PRL",
    "PUMP",
    "PYTH",
    "QNT",
    "RAY",
    "RIVER",
    "S",
    "SEI",
    "SKR",
    "SKY",
    "SOL",
    "SPX",
    "STABLE",
    "STBL",
    "STRK",
    "SUI",
    "SYRUP",
    "TAO",
    "TIA",
    "TRUMP",
    "TRX",
    "UNI",
    "USELESS",
    "VARIATIONAL",
    "VIRTUAL",
    "VVV",
    "WEN",
    "WIF",
    "WLD",
    "WLFI",
    "XLM",
    "XMR",
    "XPL",
    "XRP",
    "YZY",
    "ZEC",
    "ZK",
    "ZORA",
    "ZRO",
)
# Fixed on 2026-11-11 from symbols alone, before any return was computed.
TRADFI_SYMBOLS: tuple[str, ...] = (
    "AAOI",
    "AAPL",
    "AMD",
    "AMZN",
    "ANTHROPIC",
    "ARM",
    "ASELS",
    "ASML",
    "AUDUSD",
    "AVGO",
    "AXTI",
    "BABA",
    "BE",
    "BMNR",
    "BOTZ",
    "BRENTOIL",
    "BYD",
    "COIN",
    "CRCL",
    "CRWV",
    "CXMT",
    "DELL",
    "DIA",
    "EURUSD",
    "EWY",
    "GBPUSD",
    "GEV",
    "GME",
    "GOOGL",
    "HANMI",
    "HOOD",
    "HYUNDAI",
    "HYUNDAIUSD",
    "IBM",
    "INTC",
    "IREN",
    "IWM",
    "KIOXIA",
    "KORU",
    "KRCOMP",
    "MAGS",
    "META",
    "MINIMAX",
    "MRNA",
    "MRVL",
    "MSFT",
    "MSTR",
    "MU",
    "NATGAS",
    "NBIS",
    "NOK",
    "NOW",
    "NVDA",
    "NZDUSD",
    "OPENAI",
    "ORCL",
    "OURA",
    "PAXG",
    "PLTR",
    "POPMART",
    "QCOM",
    "QQQ",
    "RKLB",
    "SAMSUNG",
    "SAMSUNGUSD",
    "SHEIN",
    "SKHY",
    "SKHYNIX",
    "SKHYNIXUSD",
    "SMIC",
    "SNDK",
    "SOXL",
    "SOXS",
    "SOXX",
    "SPACEX",
    "SPCX",
    "SPY",
    "STRC",
    "TENCENT",
    "TSLA",
    "TSM",
    "TTWO",
    "TUR30",
    "UNITREE",
    "US100",
    "US10Y",
    "US500",
    "USDCAD",
    "USDCHF",
    "USDHKD",
    "USDJPY",
    "USDKRW",
    "WDC",
    "WHEAT",
    "WTI",
    "XAG",
    "XAU",
    "XCU",
    "XIAOMI",
    "XPD",
    "XPT",
    "ZHIPU",
)
# Fixed on 2026-11-11 from symbols alone, before any return was computed.
UNCLASSIFIED_SYMBOLS: tuple[str, ...] = (
    "BB",
    "BOT",
    "CAP",
    "CBRS",
    "CC",
    "CHIP",
    "CTR",
    "DATA",
    "DRAM",
    "H100",
    "LITE",
    "MEGA",
    "RAIL",
    "ROBO",
    "STABLECOINX",
    "STONK",
    "XTEN",
)

# Lighter symbol -> Binance USDT-M symbol, written out in full. None: no Binance counterpart assumed.
BINANCE_MAP: dict[str, str | None] = {
    "0G": "0GUSDT",
    "1000BONK": "1000BONKUSDT",
    "1000FLOKI": "1000FLOKIUSDT",
    "1000NOT": "1000NOTUSDT",
    "1000PEPE": "1000PEPEUSDT",
    "1000SHIB": "1000SHIBUSDT",
    "1000TOSHI": "1000TOSHIUSDT",
    "2Z": "2ZUSDT",
    "AAOI": "AAOIUSDT",
    "AAPL": "AAPLUSDT",
    "AAVE": "AAVEUSDT",
    "ADA": "ADAUSDT",
    "ADI": "ADIUSDT",
    "AERO": "AEROUSDT",
    "AI": "AIUSDT",
    "AI16Z": "AI16ZUSDT",
    "AMD": "AMDUSDT",
    "AMZN": "AMZNUSDT",
    "ANSEM": "ANSEMUSDT",
    "ANTHROPIC": "ANTHROPICUSDT",
    "APEX": "APEXUSDT",
    "APT": "APTUSDT",
    "ARB": "ARBUSDT",
    "ARC": "ARCUSDT",
    "ARM": "ARMUSDT",
    "ASELS": "ASELSUSDT",
    "ASML": "ASMLUSDT",
    "ASTER": "ASTERUSDT",
    "AUDUSD": "AUDUSDUSDT",
    "AVAX": "AVAXUSDT",
    "AVGO": "AVGOUSDT",
    "AVNT": "AVNTUSDT",
    "AXS": "AXSUSDT",
    "AXTI": "AXTIUSDT",
    "AZTEC": "AZTECUSDT",
    "BABA": "BABAUSDT",
    "BB": "BBUSDT",
    "BCH": "BCHUSDT",
    "BE": "BEUSDT",
    "BERA": "BERAUSDT",
    "BIO": "BIOUSDT",
    "BIRB": "BIRBUSDT",
    "BMNR": "BMNRUSDT",
    "BNB": "BNBUSDT",
    "BOT": "BOTUSDT",
    "BOTZ": "BOTZUSDT",
    "BRENTOIL": "BRENTOILUSDT",
    "BTC": "BTCUSDT",
    "BYD": "BYDUSDT",
    "CAP": "CAPUSDT",
    "CASHCAT": "CASHCATUSDT",
    "CBRS": "CBRSUSDT",
    "CC": "CCUSDT",
    "CHIP": "CHIPUSDT",
    "COIN": "COINUSDT",
    "CRCL": "CRCLUSDT",
    "CRO": "CROUSDT",
    "CRV": "CRVUSDT",
    "CRWV": "CRWVUSDT",
    "CTR": "CTRUSDT",
    "CXMT": "CXMTUSDT",
    "DASH": "DASHUSDT",
    "DATA": "DATAUSDT",
    "DELL": "DELLUSDT",
    "DIA": "DIAUSDT",
    "DOGE": "DOGEUSDT",
    "DOT": "DOTUSDT",
    "DRAM": "DRAMUSDT",
    "DRV": "DRVUSDT",
    "DUSK": "DUSKUSDT",
    "DYDX": "DYDXUSDT",
    "EDGE": "EDGEUSDT",
    "EIGEN": "EIGENUSDT",
    "ENA": "ENAUSDT",
    "ETH": "ETHUSDT",
    "ETHFI": "ETHFIUSDT",
    "EURUSD": "EURUSDUSDT",
    "EWY": "EWYUSDT",
    "FARTCOIN": "FARTCOINUSDT",
    "FF": "FFUSDT",
    "FIL": "FILUSDT",
    "FOLKS": "FOLKSUSDT",
    "GBPUSD": "GBPUSDUSDT",
    "GEV": "GEVUSDT",
    "GME": "GMEUSDT",
    "GMX": "GMXUSDT",
    "GOOGL": "GOOGLUSDT",
    "GRAM": "GRAMUSDT",
    "GRASS": "GRASSUSDT",
    "H100": "H100USDT",
    "HANMI": "HANMIUSDT",
    "HBAR": "HBARUSDT",
    "HOOD": "HOODUSDT",
    "HYPE": "HYPEUSDT",
    "HYUNDAI": "HYUNDAIUSDT",
    "HYUNDAIUSD": None,
    "IBM": "IBMUSDT",
    "ICP": "ICPUSDT",
    "INTC": "INTCUSDT",
    "IREN": "IRENUSDT",
    "IWM": "IWMUSDT",
    "JTO": "JTOUSDT",
    "JUP": "JUPUSDT",
    "KAITO": "KAITOUSDT",
    "KIOXIA": "KIOXIAUSDT",
    "KORU": "KORUUSDT",
    "KRCOMP": "KRCOMPUSDT",
    "LAUNCHCOIN": "LAUNCHCOINUSDT",
    "LDO": "LDOUSDT",
    "LINEA": "LINEAUSDT",
    "LINK": "LINKUSDT",
    "LIT": "LITUSDT",
    "LITE": "LITEUSDT",
    "LTC": "LTCUSDT",
    "MAGS": "MAGSUSDT",
    "MEGA": "MEGAUSDT",
    "MET": "METUSDT",
    "META": "METAUSDT",
    "MINIMAX": "MINIMAXUSDT",
    "MNT": "MNTUSDT",
    "MON": "MONUSDT",
    "MORPHO": "MORPHOUSDT",
    "MRNA": "MRNAUSDT",
    "MRVL": "MRVLUSDT",
    "MSFT": "MSFTUSDT",
    "MSTR": "MSTRUSDT",
    "MU": "MUUSDT",
    "NATGAS": "NATGASUSDT",
    "NBIS": "NBISUSDT",
    "NEAR": "NEARUSDT",
    "NMR": "NMRUSDT",
    "NOK": "NOKUSDT",
    "NOW": "NOWUSDT",
    "NVDA": "NVDAUSDT",
    "NZDUSD": "NZDUSDUSDT",
    "ONDO": "ONDOUSDT",
    "OP": "OPUSDT",
    "OPENAI": "OPENAIUSDT",
    "ORCL": "ORCLUSDT",
    "OURA": "OURAUSDT",
    "PAXG": "PAXGUSDT",
    "PENDLE": "PENDLEUSDT",
    "PENGU": "PENGUUSDT",
    "PIPPIN": "PIPPINUSDT",
    "PLTR": "PLTRUSDT",
    "POL": "POLUSDT",
    "PONS": "PONSUSDT",
    "POPCAT": "POPCATUSDT",
    "POPMART": "POPMARTUSDT",
    "PRL": "PRLUSDT",
    "PUMP": "PUMPUSDT",
    "PYTH": "PYTHUSDT",
    "QCOM": "QCOMUSDT",
    "QNT": "QNTUSDT",
    "QQQ": "QQQUSDT",
    "RAIL": "RAILUSDT",
    "RAY": "RAYUSDT",
    "RIVER": "RIVERUSDT",
    "RKLB": "RKLBUSDT",
    "ROBO": "ROBOUSDT",
    "S": "SUSDT",
    "SAMSUNG": "SAMSUNGUSDT",
    "SAMSUNGUSD": None,
    "SEI": "SEIUSDT",
    "SHEIN": "SHEINUSDT",
    "SKHY": "SKHYUSDT",
    "SKHYNIX": "SKHYNIXUSDT",
    "SKHYNIXUSD": None,
    "SKR": "SKRUSDT",
    "SKY": "SKYUSDT",
    "SMIC": "SMICUSDT",
    "SNDK": "SNDKUSDT",
    "SOL": "SOLUSDT",
    "SOXL": "SOXLUSDT",
    "SOXS": "SOXSUSDT",
    "SOXX": "SOXXUSDT",
    "SPACEX": "SPACEXUSDT",
    "SPCX": "SPCXUSDT",
    "SPX": "SPXUSDT",
    "SPY": "SPYUSDT",
    "STABLE": "STABLEUSDT",
    "STABLECOINX": "STABLECOINXUSDT",
    "STBL": "STBLUSDT",
    "STONK": "STONKUSDT",
    "STRC": "STRCUSDT",
    "STRK": "STRKUSDT",
    "SUI": "SUIUSDT",
    "SYRUP": "SYRUPUSDT",
    "TAO": "TAOUSDT",
    "TENCENT": "TENCENTUSDT",
    "TIA": "TIAUSDT",
    "TRUMP": "TRUMPUSDT",
    "TRX": "TRXUSDT",
    "TSLA": "TSLAUSDT",
    "TSM": "TSMUSDT",
    "TTWO": "TTWOUSDT",
    "TUR30": None,
    "UNI": "UNIUSDT",
    "UNITREE": "UNITREEUSDT",
    "US100": None,
    "US10Y": None,
    "US500": None,
    "USDCAD": "USDCADUSDT",
    "USDCHF": "USDCHFUSDT",
    "USDHKD": None,
    "USDJPY": "USDJPYUSDT",
    "USDKRW": None,
    "USELESS": "USELESSUSDT",
    "VARIATIONAL": "VARIATIONALUSDT",
    "VIRTUAL": "VIRTUALUSDT",
    "VVV": "VVVUSDT",
    "WDC": "WDCUSDT",
    "WEN": "WENUSDT",
    "WHEAT": "WHEATUSDT",
    "WIF": "WIFUSDT",
    "WLD": "WLDUSDT",
    "WLFI": "WLFIUSDT",
    "WTI": "WTIUSDT",
    "XAG": "XAGUSDT",
    "XAU": "XAUUSDT",
    "XCU": "XCUUSDT",
    "XIAOMI": "XIAOMIUSDT",
    "XLM": "XLMUSDT",
    "XMR": "XMRUSDT",
    "XPD": "XPDUSDT",
    "XPL": "XPLUSDT",
    "XPT": "XPTUSDT",
    "XRP": "XRPUSDT",
    "XTEN": "XTENUSDT",
    "YZY": "YZYUSDT",
    "ZEC": "ZECUSDT",
    "ZHIPU": "ZHIPUUSDT",
    "ZK": "ZKUSDT",
    "ZORA": "ZORAUSDT",
    "ZRO": "ZROUSDT",
}

LEADER_COIN = "BTC"

# Features.
SIGMA_BARS = 288
SIGMA_MIN_VALID = 260
REF_BARS = 288
REF_MIN_VALID = 260
GAP_REF_MIN_VALID = 200
PRINT_WINDOW_MS = 10_000
PRINT_WINDOW_END_MS = 500  # the last print of the minute must be at least this long before its end
MIN_OTHERS = 3
F6_MINUTE_OF_HOUR = 55
BPS = 1e4

# Fills and exits.
EXIT_SEARCH_MINUTES = 15
STOP_MULT = 2.0
TARGET_MULT = 2.0
TARGET1_MULT = 1.0
SPREAD_SENSITIVITY_MULT = 2.0

# Grid axes.
HOLDS: tuple[int, ...] = (5, 15, 30, 60, 120, 240)
EXITS: tuple[str, ...] = ("time", "stop2_target2", "target1")
UNIVERSES: tuple[str, ...] = ("A", "AB")
KS_REVERSAL: tuple[int, ...] = (1, 3, 12)
THETAS: tuple[float, ...] = (1.0, 1.5, 2.0)
KS_FLOW: tuple[int, ...] = (3, 12)
QS_FLOW: tuple[float, ...] = (0.8, 0.9)
FLOW_INPUTS: tuple[str, ...] = ("binance", "small", "large")
FLOW_DIRECTIONS: tuple[str, ...] = ("follow", "fade")
GAP_THETAS_BPS: tuple[int, ...] = (2, 4, 8)
GAP_VARIANTS: tuple[str, ...] = ("plain", "persist")
FUNDING_THETAS_BPS: tuple[int, ...] = (1, 2, 4)
FUNDING_HOLDS: tuple[int, ...] = (10, 20)
FAMILIES: tuple[str, ...] = ("F1", "F2", "F3", "F4", "F5", "F6")

# Noise control and passing rules.
NOISE_SEEDS: tuple[int, ...] = tuple(range(1, 21))
NOISE_SEED = 20_261_111
NOISE_MIN_DAYS = 7
NOISE_MAX_DAYS = 60
NW_LAGS = 5
PASS_MIN_T = 3.0
PASS_MIN_MONTHS_WITH_TRADES = 6
PASS_MIN_MONTH_SHARE = 0.70
PASS_MIN_MARKETS = 5
PASS_MIN_MARKET_SHARE = 0.60
PASS_MARKET_MIN_TRADES = 100
PASS_MIN_TRADES = 2_000
PASS_MAX_FLAGGED_SHARE = 0.01
MAX_MISSING_FUNDING_SHARE = 0.01
DESK_ENTRIES_PER_HOUR = 10.0
MAX_FINALISTS = 3
CONFIRM_ALPHA = 0.05
CONFIRM_MIN_POSITIVE_MONTHS = 3
TRIPWIRE_MEAN_BPS = 5.0
TRIPWIRE_T = 8.0

# Account layer.
ACCOUNT_START = 100.0
ACCOUNT_LEVERAGES: tuple[int, ...] = (3, 10, 20)
ACCOUNT_MAX_POSITIONS = 10
ACCOUNT_MIN_NOTIONAL = 10.0
ACCOUNT_MAINTENANCE = 0.012


def symbol_class(symbol: str) -> str:
    """ "crypto", "tradfi" or "unclassified". A symbol in none of the three tuples, or in several, is an error."""
    hits = [
        name
        for name, group in (
            ("crypto", CRYPTO_SYMBOLS),
            ("tradfi", TRADFI_SYMBOLS),
            ("unclassified", UNCLASSIFIED_SYMBOLS),
        )
        if symbol in group
    ]
    if len(hits) != 1:
        raise ValueError(f"symbol {symbol!r} is in {len(hits)} of the three class tuples (it must be in exactly one)")
    return hits[0]


def check_symbols(symbols: list[str]) -> None:
    """Stops with the symbol named when a perp symbol is in none of the class tuples or in more than one."""
    for s in symbols:
        symbol_class(s)


asset_class = symbol_class


def is_leader(symbol: str) -> bool:
    return symbol == LEADER_COIN


def binance_symbol(symbol: str) -> str | None:
    """The Binance USDT-M symbol of a Lighter symbol, or None when the map has none."""
    return BINANCE_MAP.get(symbol)


def classify_tier(activity_median: float, qualifying_minutes: int, spread_proxy_bps: float) -> str | None:
    """The tier of a market in a month from the previous month's figures: "A", "B" or None (not eligible)."""
    if activity_median < ELIG_MIN_MEDIAN_TRADES or qualifying_minutes < ELIG_MIN_QUALIFYING_MINUTES:
        return None
    if spread_proxy_bps <= TIER_A_MAX_BPS:
        return "A"
    if spread_proxy_bps <= TIER_B_MAX_BPS:
        return "B"
    return None


def month_index(year: int, month: int) -> int:
    return (year - 1970) * 12 + month - 1


def month_of_index(index: int) -> tuple[int, int]:
    return 1970 + index // 12, index % 12 + 1


def previous_month(year: int, month: int) -> tuple[int, int]:
    return (year - 1, 12) if month == 1 else (year, month - 1)


def noise_offsets() -> list[int]:
    """The 20 distinct shift offsets in days (run i uses the i-th)."""
    import numpy as np

    rng = np.random.default_rng(NOISE_SEED)
    return [int(x) for x in rng.choice(np.arange(NOISE_MIN_DAYS, NOISE_MAX_DAYS + 1), size=20, replace=False)]


@dataclass(frozen=True)
class Signal:
    """One signal configuration. params is a tuple of (name, value) pairs so the object is hashable."""

    sig_id: str
    family: str
    params: tuple[tuple[str, Any], ...]

    def p(self, name: str) -> Any:
        return dict(self.params)[name]


@dataclass(frozen=True)
class Config:
    cid: str
    signal: Signal
    hold: int
    exit: str
    universe: str

    @property
    def family(self) -> str:
        return self.signal.family


def _signals() -> tuple[Signal, ...]:
    out: list[Signal] = []
    for fam in ("F1", "F2", "F3"):
        for k in KS_REVERSAL:
            for th in THETAS:
                out.append(Signal(f"{fam}-k{k}-th{th}", fam, (("k", k), ("theta", th))))
    for inp in FLOW_INPUTS:
        for k in KS_FLOW:
            for q in QS_FLOW:
                for d in FLOW_DIRECTIONS:
                    out.append(
                        Signal(
                            f"F4-{inp}-k{k}-q{q}-{d}",
                            "F4",
                            (("input", inp), ("k", k), ("q", q), ("direction", d)),
                        )
                    )
    for th in GAP_THETAS_BPS:
        for v in GAP_VARIANTS:
            out.append(Signal(f"F5-th{th}-{v}", "F5", (("theta", th), ("variant", v))))
    return tuple(out)


def _funding_signals() -> tuple[Signal, ...]:
    return tuple(
        Signal(f"F6-th{th}-x{x}", "F6", (("theta", th), ("exit_min", x)))
        for th in FUNDING_THETAS_BPS
        for x in FUNDING_HOLDS
    )


SIGNALS: tuple[Signal, ...] = _signals()
FUNDING_SIGNALS: tuple[Signal, ...] = _funding_signals()


def _grid() -> tuple[Config, ...]:
    out: list[Config] = []
    for sig in SIGNALS:
        for hold in HOLDS:
            for ex in EXITS:
                for uni in UNIVERSES:
                    out.append(Config(f"{sig.sig_id}-h{hold}-{ex}-{uni}", sig, hold, ex, uni))
    for sig in FUNDING_SIGNALS:
        for uni in UNIVERSES:
            out.append(Config(f"{sig.sig_id}-time-{uni}", sig, sig.p("exit_min"), "time", uni))
    return tuple(out)


GRID: tuple[Config, ...] = _grid()
CONFIG_BY_ID: dict[str, Config] = {c.cid: c for c in GRID}
CONFIG_IDS: tuple[str, ...] = tuple(c.cid for c in GRID)
TRIALS = len(GRID)


def date_ms(day: dt.date) -> int:
    return int(dt.datetime(day.year, day.month, day.day, tzinfo=dt.UTC).timestamp() * 1000)


@functools.lru_cache(maxsize=1)
def lock_digest() -> str:
    """sha256 over the bytes of every lighter/*.py file, sorted by name (this file included).

    The code is part of the lock: any edit of any of these files changes the digest. The grid ids are covered because
    they are generated by this file.
    """
    h = hashlib.sha256()
    for path in sorted(Path(__file__).resolve().parent.glob("*.py"), key=lambda p: p.name):
        h.update(path.name.encode() + b"\0")
        h.update(path.read_bytes())
        h.update(b"\0")
    return h.hexdigest()


def ids_digest() -> str:
    """sha256 of the ordered grid ids (a cheap check that the grid itself did not move)."""
    return hashlib.sha256(json.dumps(list(CONFIG_IDS)).encode()).hexdigest()
