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
 *   npx tsx scripts/research/frontier.ts --reports a.json,b.json [--notional 50] [--target-per-day 0.5] [--trades-per-day 4,8,20,50]
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
 * Reading: the largest fine-interval effect ever measured here is raw.btcLeadLag
 * at 1h, 0.0219 at h1 (factors.ts, Phase B results): 5x the 1h maker breakeven,
 * about the 8-a-day maker line, below every taker line and below every 15m line.
 * The 15m control run (Phase A, 2026-09-26): n 4796, expectancy -0.1175%, CI95
 * [-0.1740, -0.0583], win rate 0.321, payoff 1.64, profit factor 0.769, median
 * hold 7 bars, 24.02 trades a day, random-entry p 0.244, FAIL on expectancy,
 * windows, symbols, timing, trials and stress, as every control has.
 */
import { readFile } from 'fs/promises';
import { BINANCE_FUTURES_MAKER_FEE, defaultCostPercent } from '@/lib/backtest/cost-model';
import { intervalToMs } from '@/lib/intervals';
import { validateStrategyReport, type StrategyReport } from './report-schema';

const DAY_MS = 86_400_000;

/** Maker on both legs, no slippage: the bar a continuation-shaped signal can reach. */
export const MAKER_ROUND_TRIP_PERCENT = 2 * BINANCE_FUTURES_MAKER_FEE * 100;

export interface FrontierInput {
  family: string;
  interval: string;
  n: number;
  bootstrapCi95: [number, number] | null;
  symbolsTotal: number;
  /** Sum over symbols of testWindowBars x windows: the out-of-sample span in bars. */
  oosBars: number;
}

export function frontierInputFromReport(report: StrategyReport): FrontierInput {
  return {
    family: report.family,
    interval: report.interval,
    n: report.pooled.n,
    bootstrapCi95: report.pooled.bootstrapCi95,
    symbolsTotal: report.pooled.symbolsTotal,
    oosBars: report.perSymbol.reduce((s, p) => s + p.windowConfig.testWindowBars * p.windows.length, 0),
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
  sdPercent: number;
  costTakerPercent: number;
  costMakerPercent: number;
  breakevenIcTaker: number;
  breakevenIcMaker: number;
  targets: Array<{ tradesPerDay: number; icTaker: number; icMaker: number }>;
}

export interface FrontierOptions {
  notionalUsdt: number;
  targetPerDayUsdt: number;
  tradesPerDay: number[];
}

export function frontierRow(input: FrontierInput, opts: FrontierOptions): FrontierRow {
  const sd = sdPerTradeFromCi(input.bootstrapCi95, input.n);
  const costTaker = defaultCostPercent(input.interval);
  const costMaker = MAKER_ROUND_TRIP_PERCENT;
  const targets = opts.tradesPerDay.map((N) => {
    const netPerTradePercent = (opts.targetPerDayUsdt / N / opts.notionalUsdt) * 100;
    return {
      tradesPerDay: N,
      icTaker: requiredIc(netPerTradePercent + costTaker, sd),
      icMaker: requiredIc(netPerTradePercent + costMaker, sd),
    };
  });
  return {
    family: input.family,
    interval: input.interval,
    n: input.n,
    tradesPerDay: tradesPerDayOf(input),
    sdPercent: sd,
    costTakerPercent: costTaker,
    costMakerPercent: costMaker,
    breakevenIcTaker: requiredIc(costTaker, sd),
    breakevenIcMaker: requiredIc(costMaker, sd),
    targets,
  };
}

function fmt(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

export function formatFrontier(rows: FrontierRow[], opts: Pick<FrontierOptions, 'notionalUsdt' | 'targetPerDayUsdt'>): string {
  const lines: string[] = [];
  lines.push(
    `frontier: notional ${opts.notionalUsdt} USDT per trade, target ${opts.targetPerDayUsdt} USDT per day; ` +
      `ic = gross / (2 x sd per trade)`
  );
  lines.push(
    ['family', 'iv', 'n', 'trades/day', 'sd%', 'cost taker', 'cost maker', 'be taker', 'be maker']
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
        fmt(r.sdPercent, 2).padEnd(12),
        fmt(r.costTakerPercent, 3).padEnd(12),
        fmt(r.costMakerPercent, 3).padEnd(12),
        fmt(r.breakevenIcTaker, 4).padEnd(12),
        fmt(r.breakevenIcMaker, 4),
      ].join('')
    );
    for (const t of r.targets) {
      lines.push(`    at ${String(t.tradesPerDay).padStart(3)} trades/day: ic taker ${fmt(t.icTaker, 4)}, ic maker ${fmt(t.icMaker, 4)}`);
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
const VALUE_FLAGS = new Set(['reports', 'notional', 'target-per-day', 'trades-per-day']);

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
  return {
    reports: list(reportsRaw),
    notionalUsdt: flags.has('notional') ? positiveNumber(flags.get('notional')!, 'notional') : 50,
    targetPerDayUsdt: flags.has('target-per-day')
      ? positiveNumber(flags.get('target-per-day')!, 'target-per-day')
      : 0.5,
    tradesPerDay: flags.has('trades-per-day')
      ? list(flags.get('trades-per-day')!).map((entry) => positiveNumber(entry, 'trades-per-day'))
      : [4, 8, 20, 50],
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
