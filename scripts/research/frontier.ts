/**
 * The frequency frontier: what the recorded strategy reports imply about how
 * often a rule can act and what per-trade edge that needs, restated as the
 * information coefficient a factor would have to carry.
 *
 * WHY. The user's question on 2026-09-26 was how to take more trades within
 * the day on a base of about 100 USDT. Trade count is a free knob (cutoff,
 * interval, universe); expectancy is not, and daily P&L is count times
 * expectancy. Cost is fixed per round trip while the return a trade can earn
 * scales with holding period, so the honest comparison is in IC units per
 * interval, not in percent per trade.
 *
 * ic = gross / (2 x sd per trade). The 2 is the expected |z| of a score
 * conditional on clearing a cutoff near p90 (1.75; 2.06 at p95), so it is the
 * right multiplier for trades taken only in the tails, not a long-short
 * spread. sd per trade is recovered from a report's percentile bootstrap CI:
 * half-width x sqrt(n) / 1.96.
 *
 * Usage:
 *   npx tsx scripts/research/frontier.ts --reports a.json,b.json [--notional 50] [--target-per-day 0.5] [--trades-per-day 4,8,20,50] [--fee-profile standard|bnb|promo-btc-eth-2026-07]
 *   --fee-profile prices the `targets` block and the leverage block's round
 *   trip under that schedule (default standard, the schedule every recorded
 *   number above is on); `profiles:` always prices all three regardless of
 *   the flag, for BTCUSDT, so the promotion column shows the promoted pair
 *   rather than its bnb fallback.
 *
 * MEASURED 2026-09-26 (Phase 4 control reports plus the Phase A control run at 15m, task pA):
 *   family   iv    n      trades/day  sd%    cost taker  cost maker  be taker  be maker
 *   control  5m    19414  115.31      0.78   0.200       0.040       0.1274    0.0255
 *   control  15m   4796   24.02       2.04   0.160       0.040       0.0391    0.0098
 *   control  1h    7519   7.34        4.56   0.160       0.040       0.0176    0.0044
 *   control  4h    1619   1.07        9.21   0.140       0.040       0.0076    0.0022
 *   control  1d    157    0.14        15.92  0.140       0.040       0.0044    0.0013
 *
 *   Target 0.5 USDT a day on 50 USDT per trade, IC needed (taker / maker):
 *   5m  at 20/day 0.1593 / 0.0573, at 50/day 0.1402 / 0.0382
 *   15m at 8/day 0.0697 / 0.0403, at 20/day 0.0514 / 0.0220, at 50/day 0.0440 / 0.0147
 *   1h  at 4/day 0.0450 / 0.0318, at 8/day 0.0313 / 0.0181, at 20/day 0.0230 / 0.0099
 *   4h  at 4/day 0.0212 / 0.0157
 *
 * SUPERSEDED 2026-10-01 (review M6): every IC in the two tables above was
 * computed from the CI-implied sd, which carries the cross-symbol correlation
 * of simultaneous trades and runs 1.6 to 2.0x the raw per-trade sd intraday.
 * The IC conversion needs one trade's dispersion, so each breakeven above is
 * understated by that ratio and every "near miss" measured against it was
 * farther away than recorded. RE-MEASURED from the same five reports, raw sd
 * recovered as expectancy / observedSharpe (`rawSdFromReport`):
 *   family   iv    n      trades/day  raw sd%  eff sd%  cost taker  cost maker  be taker  be maker
 *   control  5m    19414  115.31      0.424    0.78     0.200       0.040       0.2356    0.0471
 *   control  15m   4796   24.02       1.021    2.04     0.160       0.040       0.0783    0.0196
 *   control  1h    7519   7.34        2.431    4.56     0.160       0.040       0.0329    0.0082
 *   control  4h    1619   1.07        5.828    9.21     0.140       0.040       0.0120    0.0034
 *   control  1d    157    0.14        13.633   15.92    0.140       0.040       0.0051    0.0015
 *
 *   Target 0.5 USDT a day on 50 USDT per trade, IC needed (taker / maker):
 *   5m  at 20/day 0.2945 / 0.1060, at 50/day 0.2592 / 0.0707
 *   15m at 8/day 0.1395 / 0.0808, at 20/day 0.1028 / 0.0441, at 50/day 0.0881 / 0.0294
 *   1h  at 4/day 0.0843 / 0.0597, at 8/day 0.0586 / 0.0339, at 20/day 0.0432 / 0.0185
 *   4h  at 4/day 0.0335 / 0.0249
 *
 *   Against the largest fine-interval effect ever measured, raw.btcLeadLag 1h
 *   h1 0.0219: the 1h maker breakeven is 0.0082 and the taker 0.0329, so it
 *   clears maker and misses taker by 1.5x, and the hold-mismatch caveat below
 *   still applies on top. The effective sd stays the right number for what a
 *   sample can DETECT; only the IC conversion changed.
 *
 * MEASURED 2026-09-26, per fee profile (Task 3, CLI on the pA report,
 * `npx tsx scripts/research/frontier.ts --reports
 * data/research/reports/strategy-control-15m-pA.json`):
 *   profiles (priced for BTCUSDT):
 *     standard                taker 0.160 (be 0.0391)  maker 0.040 (be 0.0098)
 *     bnb                     taker 0.150 (be 0.0367)  maker 0.036 (be 0.0088)
 *     promo-btc-eth-2026-07   taker 0.132 (be 0.0323)  maker 0.000 (be 0.0000)
 *   leverage (100 USDT base, standard taker round trip at this interval):
 *     L 1: notional 100 USDT, cost 0.1600 USDT (0.160% of account), liq dist 99.60%
 *     L 5: notional 500 USDT, cost 0.8000 USDT (0.800% of account), liq dist 19.60%
 *     L10: notional 1000 USDT, cost 1.6000 USDT (1.600% of account), liq dist 9.60%
 *     L20: notional 2000 USDT, cost 3.2000 USDT (3.200% of account), liq dist 4.60%
 *   The promo column is hypothetical for USDT-M pairs: verified 2026-09-27 on
 *   the account fee page, that schedule is on USDC-margined contracts only
 *   (USDC 0.0000% / 0.0400%, 0.0360% with BNB); USDT-M is 0.0200% / 0.0500%
 *   (0.0180% / 0.0450% with BNB), so bnb is the cheapest real line here.
 *
 * Reading: the largest fine-interval effect ever measured here is raw.btcLeadLag
 * at 1h, 0.0219 at h1 (factors.ts, Phase B results): 5x the 1h maker breakeven,
 * about the 8-a-day maker line, below every taker line and below every 15m line.
 * The 15m control run (Phase A, 2026-09-26): n 4796, expectancy -0.1175%, CI95
 * [-0.1740, -0.0583], win rate 0.321, payoff 1.64, profit factor 0.769, median
 * hold 7 bars, 24.02 trades a day, random-entry p 0.244, FAIL on expectancy,
 * windows, symbols, timing, trials and stress, as every control has.
 *
 * CAVEAT (2026-09-26): the "5x the 1h maker breakeven" line above is
 * SUPERSEDED. That line compared raw.btcLeadLag's 0.0219 against a breakeven
 * of 0.0044 computed by ic = gross / (2 x sd per trade) using the control
 * family's 4.56% per-trade sd at 1h -- the dispersion of a multi-bar hold,
 * not of one bar. raw.btcLeadLag is scored one to two bars ahead, where the
 * per-trade sd is the bar sd: about 0.54% on BTC and up to about 0.8% on the
 * alts at 1h. At that hold the breakeven IC is about 0.025 to 0.037, not
 * 0.0044, so 0.0219 falls short of breakeven rather than clearing it 5x;
 * equivalently, in gross terms, an IC of 0.0219 represents a gross of about
 * 0.02 to 0.035% per trade, not the 0.20% the control sd would imply. The
 * report's own decile spreads confirm the smaller number without going
 * through IC at all: top decile +0.022% at h1 and +0.045% at h2, bottom
 * decile -0.014% at h1 and -0.017% at h2, all at or below the 0.04% maker
 * round trip and every one below the 0.16% taker round trip. Compare a
 * hold's own gross against its own round trip, never against a breakeven
 * derived from a different rule's sd.
 *
 * LEVERAGE: fees and edge are both rates per unit of notional; leverage
 * multiplies the position's notional, not the per-unit rate, so a round
 * trip's cost as a percent of the account scales linearly with leverage
 * (cost USDT = notional x round-trip% / 100, and notional = base x L) while
 * its cost as a percent of notional never changes. The other side of that
 * multiplier is liquidation: distance to liquidation is about 1/L minus the
 * maintenance margin rate (default 0.4%), so 20x leaves about 4.6% of room
 * and 50x about 1.6%, a band an ordinary intraday range on a control-family
 * hold can cross before the trade's edge has had time to realize.
 *
 * RANK BOOK TRANSLATION, 2026-09-28 (descriptive; nothing passed the gates,
 * see exposure-gates.ts PHASE 3 PLAN 2 RESULT). topBottom k=1 on ten symbols
 * is one long and one short of 50 USDT each, 100 USDT gross at 1x. linearRank
 * on ten symbols holds all ten with weights from 0.02 to 0.18 of gross, so
 * the smallest weight at a 50 USDT minimum notional needs 2,500 USDT gross,
 * 25x on 100 USDT, 5x on 500 USDT. linearRank was selected in eleven of the
 * twelve windows, with 4h window 5 selecting topBottom k=1 at band 0. The
 * 100 USDT base cannot implement linearRank at 1x.
 */
import { readFile } from 'fs/promises';
import {
  BINANCE_FUTURES_MAKER_FEE,
  DEFAULT_FEE_PROFILE,
  FEE_PROFILE_NAMES,
  defaultCostPercent,
  isFeeProfileName,
  resolveFeeProfile,
  type FeeProfileName,
} from '@/lib/backtest/cost-model';
import { intervalToMs } from '@/lib/intervals';
import { leverageRows, liquidationDistancePercent } from '@/lib/costs/leverage';
import { validateStrategyReport, type StrategyReport } from './report-schema';

const DAY_MS = 86_400_000;

/** Moved to src/lib/costs/leverage.ts for the Cost Check page; re-exported so this module's API is unchanged. */
export { leverageRows, liquidationDistancePercent };

/** Maker on both legs, no slippage: the bar a continuation-shaped signal can reach. */
export const MAKER_ROUND_TRIP_PERCENT = 2 * BINANCE_FUTURES_MAKER_FEE * 100;

/**
 * EFFECTIVE per-trade sd (percent) recovered from the recorded control
 * reports' bootstrap CIs at each interval (the "sd%" column of the 2026-09-26
 * MEASURED table above). It folds in the cross-symbol correlation of trades
 * taken at the same time, so it is the right number for what a sample can
 * DETECT and the wrong one for converting an IC into a per-trade return
 * (review M6, 2026-10-01; see RECORDED_CONTROL_RAW_SD_PERCENT). Kept unchanged
 * so `composite-audit.ts`'s recorded output still reproduces.
 */
export const RECORDED_CONTROL_SD_PERCENT: Record<string, number> = {
  '5m': 0.78,
  '15m': 2.04,
  '1h': 4.56,
  '4h': 9.21,
  '1d': 15.92,
};

/**
 * RAW per-trade sd (percent) of the same five control reports, recovered as
 * expectancyPercent / deflatedSharpe.observedSharpe (observedSharpe is the
 * pooled per-trade mean over the sample sd). Measured 2026-10-01 from
 * data/research/reports: 5m/1h/4h/1d Phase 4 on 3fdeac9e495e, 15m pA on
 * e84cd66dbe01. Effective over raw: 1.85, 2.00, 1.87, 1.58, 1.17.
 */
export const RECORDED_CONTROL_RAW_SD_PERCENT: Record<string, number> = {
  '5m': 0.424,
  '15m': 1.021,
  '1h': 2.431,
  '4h': 5.828,
  '1d': 13.633,
};

export interface FrontierInput {
  family: string;
  interval: string;
  n: number;
  bootstrapCi95: [number, number] | null;
  symbolsTotal: number;
  /** Sum over symbols of testWindowBars x windows: the out-of-sample span in bars. */
  oosBars: number;
  /** Raw per-trade sd (percent), NaN when the report cannot supply one. */
  rawSdPercent: number;
}

/**
 * Raw per-trade sd of a report: `pooled.sdPercent` when the report carries it
 * (written since 2026-10-01), otherwise recovered as expectancyPercent /
 * deflatedSharpe.observedSharpe, otherwise NaN.
 */
export function rawSdFromReport(report: StrategyReport): number {
  const recorded = report.pooled.sdPercent;
  if (typeof recorded === 'number' && Number.isFinite(recorded) && recorded > 0) return recorded;
  const expectancy = report.pooled.expectancyPercent;
  const observed = report.pooled.deflatedSharpe?.observedSharpe;
  if (
    typeof expectancy === 'number' &&
    typeof observed === 'number' &&
    Number.isFinite(expectancy) &&
    Number.isFinite(observed) &&
    Math.abs(observed) > 1e-9
  ) {
    const sd = expectancy / observed;
    return sd > 0 ? sd : NaN;
  }
  return NaN;
}

export function frontierInputFromReport(report: StrategyReport): FrontierInput {
  return {
    family: report.family,
    interval: report.interval,
    n: report.pooled.n,
    bootstrapCi95: report.pooled.bootstrapCi95,
    symbolsTotal: report.pooled.symbolsTotal,
    oosBars: report.perSymbol.reduce((s, p) => s + p.windowConfig.testWindowBars * p.windows.length, 0),
    rawSdPercent: rawSdFromReport(report),
  };
}

/** Per-trade sd from a percentile bootstrap CI of the mean: half-width x sqrt(n) / 1.96. */
export function sdPerTradeFromCi(ci: [number, number] | null, n: number): number {
  if (!ci || n < 2) return NaN;
  return (((ci[1] - ci[0]) / 2) * Math.sqrt(n)) / 1.96;
}

/** The IC a factor needs for a per-trade gross of grossPercent at this dispersion. */
export function requiredIc(grossPercent: number, sdPercent: number): number {
  return sdPercent > 0 ? grossPercent / (2 * sdPercent) : NaN;
}

export function tradesPerDayOf(input: FrontierInput): number {
  const days = (input.oosBars * intervalToMs(input.interval)) / DAY_MS;
  return days > 0 ? (input.n / days) * input.symbolsTotal : NaN;
}

export interface FrontierRow {
  family: string;
  interval: string;
  n: number;
  tradesPerDay: number;
  /** The sd every IC in this row is computed from: raw when known, else effective. */
  sdPercent: number;
  sdBasis: 'raw' | 'effective';
  /** Raw per-trade sd (NaN when the report cannot supply one). */
  rawSdPercent: number;
  /** CI-implied sd, carrying cross-symbol correlation: for detectability, not IC. */
  effectiveSdPercent: number;
  costTakerPercent: number;
  costMakerPercent: number;
  breakevenIcTaker: number;
  breakevenIcMaker: number;
  targets: Array<{ tradesPerDay: number; icTaker: number; icMaker: number }>;
  profiles: Array<{
    profile: FeeProfileName;
    costTakerPercent: number;
    costMakerPercent: number;
    breakevenIcTaker: number;
    breakevenIcMaker: number;
  }>;
}

export interface FrontierOptions {
  notionalUsdt: number;
  targetPerDayUsdt: number;
  tradesPerDay: number[];
  /** Drives the `targets` block and, via `formatFrontier`'s chosen profile,
   * the leverage block's round trip. Default `standard`. */
  feeProfile?: FeeProfileName;
}

export function frontierRow(input: FrontierInput, opts: FrontierOptions): FrontierRow {
  // The IC conversion needs one trade's dispersion, so it takes the RAW sd.
  // Until 2026-10-01 it took the CI-implied sd, which carries cross-symbol
  // correlation and runs 1.6 to 2.0x the raw value intraday, so every
  // breakeven IC was understated by that factor (review M6). The effective sd
  // is the fallback only for a report that cannot supply a raw one.
  const effectiveSd = sdPerTradeFromCi(input.bootstrapCi95, input.n);
  const rawSd = input.rawSdPercent;
  const sdBasis: 'raw' | 'effective' = Number.isFinite(rawSd) && rawSd > 0 ? 'raw' : 'effective';
  const sd = sdBasis === 'raw' ? rawSd : effectiveSd;
  // Continuity with the recorded header table: these top-level fields stay
  // the standard-profile numbers regardless of opts.feeProfile.
  const costTaker = defaultCostPercent(input.interval);
  const costMaker = MAKER_ROUND_TRIP_PERCENT;

  const targetFeeProfile = opts.feeProfile ?? DEFAULT_FEE_PROFILE;
  const targetCostTaker = defaultCostPercent(input.interval, { profile: targetFeeProfile, symbol: 'BTCUSDT' });
  const targetCostMaker = 2 * resolveFeeProfile(targetFeeProfile, 'BTCUSDT').makerFee * 100;
  const targets = opts.tradesPerDay.map((N) => {
    const netPerTradePercent = (opts.targetPerDayUsdt / N / opts.notionalUsdt) * 100;
    return {
      tradesPerDay: N,
      icTaker: requiredIc(netPerTradePercent + targetCostTaker, sd),
      icMaker: requiredIc(netPerTradePercent + targetCostMaker, sd),
    };
  });

  // Priced for symbol BTCUSDT so the promotion column shows the promoted
  // pair, not its bnb fallback for a symbol that never gets it.
  const profiles = FEE_PROFILE_NAMES.map((name) => {
    const takerPercent = defaultCostPercent(input.interval, { profile: name, symbol: 'BTCUSDT' });
    const makerPercent = 2 * resolveFeeProfile(name, 'BTCUSDT').makerFee * 100;
    return {
      profile: name,
      costTakerPercent: takerPercent,
      costMakerPercent: makerPercent,
      breakevenIcTaker: requiredIc(takerPercent, sd),
      breakevenIcMaker: requiredIc(makerPercent, sd),
    };
  });

  return {
    family: input.family,
    interval: input.interval,
    n: input.n,
    tradesPerDay: tradesPerDayOf(input),
    sdPercent: sd,
    sdBasis,
    rawSdPercent: rawSd,
    effectiveSdPercent: effectiveSd,
    costTakerPercent: costTaker,
    costMakerPercent: costMaker,
    breakevenIcTaker: requiredIc(costTaker, sd),
    breakevenIcMaker: requiredIc(costMaker, sd),
    targets,
    profiles,
  };
}

function fmt(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

export function formatFrontier(
  rows: FrontierRow[],
  opts: Pick<FrontierOptions, 'notionalUsdt' | 'targetPerDayUsdt' | 'feeProfile'>
): string {
  const feeProfile = opts.feeProfile ?? DEFAULT_FEE_PROFILE;
  const lines: string[] = [];
  lines.push(
    `frontier: notional ${opts.notionalUsdt} USDT per trade, target ${opts.targetPerDayUsdt} USDT per day; ` +
      `ic = gross / (2 x raw sd per trade); targets priced under fee profile ${feeProfile}`
  );
  lines.push(
    ['family', 'iv', 'n', 'trades/day', 'raw sd%', 'eff sd%', 'cost taker', 'cost maker', 'be taker', 'be maker']
      .map((h) => h.padEnd(12))
      .join('')
  );
  for (const r of rows) {
    lines.push(
      [
        r.family.padEnd(12),
        r.interval.padEnd(12),
        String(r.n).padEnd(12),
        fmt(r.tradesPerDay, 2).padEnd(12),
        (fmt(r.rawSdPercent, 3) + (r.sdBasis === 'effective' ? '*' : '')).padEnd(12),
        fmt(r.effectiveSdPercent, 2).padEnd(12),
        fmt(r.costTakerPercent, 3).padEnd(12),
        fmt(r.costMakerPercent, 3).padEnd(12),
        fmt(r.breakevenIcTaker, 4).padEnd(12),
        fmt(r.breakevenIcMaker, 4),
      ].join('')
    );
    for (const t of r.targets) {
      lines.push(`    at ${String(t.tradesPerDay).padStart(3)} trades/day: ic taker ${fmt(t.icTaker, 4)}, ic maker ${fmt(t.icMaker, 4)}`);
    }

    lines.push('  profiles (priced for BTCUSDT):');
    for (const p of r.profiles) {
      lines.push(
        `    ${p.profile.padEnd(24)}taker ${fmt(p.costTakerPercent, 3)} (be ${fmt(p.breakevenIcTaker, 4)})  ` +
          `maker ${fmt(p.costMakerPercent, 3)} (be ${fmt(p.breakevenIcMaker, 4)})`
      );
    }

    const chosen = r.profiles.find((p) => p.profile === feeProfile);
    const roundTripPercent = chosen ? chosen.costTakerPercent : r.costTakerPercent;
    lines.push(`  leverage (100 USDT base, ${feeProfile} taker round trip at this interval):`);
    for (const lev of leverageRows(100, [1, 5, 10, 20], roundTripPercent)) {
      lines.push(
        `    L${String(lev.leverage).padStart(2)}: notional ${fmt(lev.notionalUsdt, 0)} USDT, ` +
          `cost ${fmt(lev.costUsdt, 4)} USDT (${fmt(lev.costPercentOfAccount, 3)}% of account), ` +
          `liq dist ${fmt(liquidationDistancePercent(lev.leverage), 2)}%`
      );
    }
  }
  return lines.join('\n');
}

export interface FrontierArgs extends FrontierOptions {
  reports: string[];
}

// Every flag this CLI takes. An unrecognized --flag is rejected rather than
// silently absorbed as a no-op (and its value token silently swallowed), the
// same rule factor-ic.ts applies: a typo must fail loudly, not quietly print
// the defaults.
const VALUE_FLAGS = new Set(['reports', 'notional', 'target-per-day', 'trades-per-day', 'fee-profile']);

/** Every number here divides or scales a required IC, so zero, a negative and NaN are all wrong answers. */
function positiveNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${flag} must be a finite positive number, got "${raw}"`);
  }
  return value;
}

export function parseArgs(argv: string[]): FrontierArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (!VALUE_FLAGS.has(key)) throw new Error(`Unknown flag --${key}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    flags.set(key, value);
    i++;
  }
  const reportsRaw = flags.get('reports');
  if (!reportsRaw) throw new Error('--reports is required (comma-separated strategy report paths)');
  const list = (s: string) => s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);

  const feeProfileRaw = flags.get('fee-profile') ?? DEFAULT_FEE_PROFILE;
  if (!isFeeProfileName(feeProfileRaw)) {
    throw new Error(`Unknown --fee-profile "${feeProfileRaw}", expected one of: ${FEE_PROFILE_NAMES.join(', ')}`);
  }

  return {
    reports: list(reportsRaw),
    notionalUsdt: flags.has('notional') ? positiveNumber(flags.get('notional')!, 'notional') : 50,
    targetPerDayUsdt: flags.has('target-per-day')
      ? positiveNumber(flags.get('target-per-day')!, 'target-per-day')
      : 0.5,
    tradesPerDay: flags.has('trades-per-day')
      ? list(flags.get('trades-per-day')!).map((entry) => positiveNumber(entry, 'trades-per-day'))
      : [4, 8, 20, 50],
    feeProfile: feeProfileRaw,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rows: FrontierRow[] = [];
  for (const path of args.reports) {
    const validated = validateStrategyReport(JSON.parse(await readFile(path, 'utf8')));
    if (!validated.ok) throw new Error(`${path} failed schema validation:\n${validated.issues.join('\n')}`);
    rows.push(frontierRow(frontierInputFromReport(validated.data), args));
  }
  console.log(formatFrontier(rows, args));
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
