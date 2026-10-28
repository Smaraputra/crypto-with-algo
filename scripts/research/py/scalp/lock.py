"""SCALP STUDY S1 LOCK: 1h-context scalping on Binance USDT-M perpetuals, span R. Registered 2026-10-29 (session 44)
before any outcome of these rules is computed. Owner request (2026-10-29): can the current research support a paper
desk that uses the 1h timeframe and scalps, on the order of a thousand trades a day, under Binance futures fees and a
$100 starting account. This lock is separate from the Round 4 method lock M and changes nothing in it.

WHAT WAS READ BEFORE THIS LOCK (disclosed)
- Every earlier intraday study in the repository (inventory by Codex, read-only, 2026-10-29, spot-checked by Claude):
  all 5m families of Phase 4 lost about 0.18% per trade after costs (scripts/research/strategy-families.ts:100-104),
  v8's live 1m and 5m calls lost 0.19% to 0.20% per call (scripts/research/live-record.ts:103-104), the snipe RSI
  reversal had a hit rate below maker break-even (scripts/research/snipe.ts:249-252), qh-flow was NULL, and the
  February 2026 live Binance account was gross break-even and lost 383.81 to fees.
- On span R, the realised SD of 5m, 15m, 1h and 1d log returns per coin (prices only, no rule outcome), measured on
  the VPS from perpcandles on 2026-10-29: BTC 10.7, 18.3, 36.0 and 186 bps, up to ADA 25.1, 43.7, 83.2 and 391 bps.
- Binance USDT-M fees (agy research, binance.com/en/fee/futureFee, 2026-10-29): VIP 0 maker 0.02%, taker 0.05%, a
  10% discount when fees are paid in BNB, no USDT-M maker promotion. Order limits 1,200 a minute and 300 a 10 seconds
  per account, so a thousand trades a day is not rate-bound.

DATA
- Perp 5m klines (open, high, low, close, volume, taker buy volume) and funding settlements of the 10 signal coins
  (r4.method.UNIVERSE) from the production collections perpcandles (series klines) and fundingsettlements.
- Span R of lock M: 2026-07-01 00:00 to 2026-10-28 00:00 UTC (exclusive). Lock M keeps R descriptive only and never
  uses it to select a Round 4 configuration, so this study's read of R leaves Round 4 unaffected. No D or H bar is
  read. 2026-07-01 to 2026-07-03 is warm-up only. Trading decisions run from 2026-07-03 00:00 (117 days).
- A coin with a missing 5m bar has no decision at that bar and no feature window through it. A hold whose exit bar is
  missing exits at the next available open. Both are counted.

FEATURES at each 5m close T, from bars closing at or before T only
- r5(T) = log(close of the bar ending at T / close of the bar ending at T - 5m).
- s5(T) = sample SD of the last 288 values of r5 ending at T.
- trend(T) = sign(C - E), where C is the close of the last completed 1h bar (5m bars aggregated on the UTC hour grid)
  and E the EMA of completed 1h closes with alpha 2 / 21, seeded by the first 20 closes' mean. 0 when C = E.
- imb(T) = 2 x taker buy volume / volume - 1 for the bar ending at T, 0 when the volume is 0.
- q(T) = the 80th percentile of abs(imb) over the last 288 bars ending at T.

RULES (side at T; no trade otherwise). One position per coin and rule at a time: signals while that coin is held by
the same configuration are ignored.
- P1 trend pullback: trend +1 and r5 <= -s5 gives long; trend -1 and r5 >= +s5 gives short.
- P2 short-term reversal: r5 >= +s5 gives short; r5 <= -s5 gives long.
- P3 flow with trend: trend +1 and imb >= q gives long; trend -1 and imb <= -q gives short.

HOLDS h: 15 minutes and 60 minutes, exit at the 5m open at entry stamp + h.

EXECUTION
- taker: enter at the 5m open at T (the bar [T, T + 5m)). Fee 0.05% per side plus the coin's slippage per side
  (r4.costs.COIN_SLIPPAGE_BPS: BTC and ETH 1 bp; BNB, SOL, XRP and DOGE 2; AVAX, DOT and LINK 3; ADA 5).
- maker_entry: a limit at the close at T. It fills at that price when the bar [T, T + 5m) trades strictly through it
  (low < limit for a buy, high > limit for a sell), else there is no trade and the coin stays free. Maker fee 0.02%,
  no slippage. The exit is taker at the open at T + h (0.05% plus slippage). The entry stamp is T.
- Netting (as Round 4 Amendment 1, A1.1): when one configuration's exit and its next entry on the same coin are both
  taker fills at the same 5m open, fees and slippage are charged on the net position change only (a continuation on
  the same side pays nothing, a flip pays one unit).
- Funding: a hold pays side x rate on its notional at each settlement in (entry stamp, exit stamp].
- No BNB discount in the gated numbers. A sensitivity with 0.018% and 0.045% is reported.

CONFIGURATIONS: 3 rules x 2 holds x 2 executions = 12, ids "{rule}_{15m|60m}_{taker|maker}". Trials: 12, ledger entry
scalp-s1-r. Program total 2,204 + 12 = 2,216.

STATISTICS per configuration
- Per trade: gross = side x log(exit price / entry price), cost (fees and slippage after netting, as a log-return
  fraction of notional), funding, net = gross - cost - funding. Trades per day, hit rate (net > 0), maker fill rate.
- Daily net: the sum of net over trades that exit on that UTC day (one unit of notional per trade). t = mean / (SD /
  sqrt(days)) over the 117 trading days, days without trades counted as 0. Monthly net sums for July (from the 3rd),
  August, September and October (to the 27th).

DECISION TABLE (registered)
- A configuration PASSES when its net mean per trade is above 0, its daily-net t is at least 3.0, and at least 3 of
  its 4 monthly net sums are positive.
- PREDICTION: 0 of 12 pass, and every taker configuration's gross mean per trade is below its cost per trade.
- If any configuration passes, nothing goes live and no paper desk starts from this result. A forward-only lock for
  the owner to sign is drafted, with this R result labelled descriptive (R was not out of sample for the rules' design
  choices).
- If none passes, the study records that the current research does not support a scalping paper desk on these rules.

$100 ACCOUNT, report only (not gated)
- Each configuration on a $100 account at 10x and at 50x, through r4.account where its interface allows (today's
  filters, the smallest-bracket maintenance margin, liquidation at each bar's adverse extreme, cross margin). Notional
  per trade = equity x leverage / 10 at entry. Reported: final equity, peak-to-trough drawdown, liquidation instant,
  and trades refused by the minimum notional.

BREAK-EVEN REFERENCE, not a trial
- For a sign bet on a normal return with SD s_h over the hold, the expected gross per trade is 0.798 x rho x s_h,
  where rho is the forecast's correlation with the return. The break-even rho per coin is the round trip / (0.798 x
  s_h), from R's measured s_h, for the taker round trip and for a maker-maker round trip of 0.04%.
"""

from __future__ import annotations

from r4.method import UNIVERSE

SPAN_START_MS = 1782864000000  # 2026-07-01 00:00 UTC
TRADE_START_MS = 1783036800000  # 2026-07-03 00:00 UTC
SPAN_END_MS = 1793145600000  # 2026-10-28 00:00 UTC, exclusive
FIVE_MIN_MS = 300_000
HOUR_MS = 3_600_000
DAY_MS = 86_400_000
TRADING_DAYS = 117

SYMBOLS: tuple[str, ...] = tuple(UNIVERSE)
SIGMA_BARS = 288
EMA_SPAN = 20
K_SIGMA = 1.0
IMB_QUANTILE = 0.8
IMB_BARS = 288

RULES: tuple[str, ...] = ("P1", "P2", "P3")
HOLDS_MS: dict[str, int] = {"15m": 15 * 60_000, "60m": 60 * 60_000}
EXECUTIONS: tuple[str, ...] = ("taker", "maker")

MAKER_FEE = 0.0002
TAKER_FEE = 0.0005
BNB_MAKER_FEE = 0.00018
BNB_TAKER_FEE = 0.00045
MAKER_ROUND_TRIP = 2 * MAKER_FEE

PASS_T = 3.0
PASS_MONTHS = 3
MONTHS: tuple[tuple[str, int, int], ...] = (
    ("2026-07", TRADE_START_MS, 1785542400000),
    ("2026-08", 1785542400000, 1788220800000),
    ("2026-09", 1788220800000, 1790812800000),
    ("2026-10", 1790812800000, SPAN_END_MS),
)

START_EQUITY = 100.0
LEVERAGES: tuple[int, ...] = (10, 50)
SLOTS = 10

CONFIG_IDS: tuple[str, ...] = tuple(f"{r}_{h}_{e}" for r in RULES for h in HOLDS_MS for e in EXECUTIONS)
TRIALS = len(CONFIG_IDS)
LEDGER_ID = "scalp-s1-r"
