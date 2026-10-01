/**
 * What the paper desk has actually done, per book.
 *
 * The desk books every trade twice: the `engine` price, which is what
 * `runBarLoop` books and so is comparable with every recorded research
 * number, and the `executable` price, which is what a live order would have
 * got. The difference is the lag cost no research run has measured, and it is
 * reported as its own column rather than folded into either track.
 *
 * What the numbers mean, and what they do not:
 *
 * - Expectancy is per trade, net of fees, slippage and funding, in percent of
 *   entry notional. It is NOT annualised and NOT compounded.
 * - The confidence interval is a stationary block bootstrap over the trade
 *   sequence, which keeps neighbouring trades together, because consecutive
 *   trades on one symbol are not independent.
 * - Win rate is reported and never targeted, per the standing programme
 *   decision: a rule can win most of its trades and still lose money.
 * - Books are never pooled. A 1m book and a 1h book pay the same round-trip
 *   cost against very different earnable moves.
 *
 * Run it in production inside the seeder image on the internal network:
 *
 *   docker run --rm --network crypto_crypto-internal --env-file .env \
 *     crypto-ops:history npx tsx scripts/ops/paper-desk-outcomes.ts
 *
 * Locally, point it at a database with `--mongo-uri`.
 *
 * Flags:
 *   --book <style:interval>   one book only, e.g. day_trading:1h
 *   --symbol <SYMBOL>         one symbol only
 *   --since <ISO date>        trades that closed at or after this moment
 *   --config-version <n>      the scorer epoch to read (default: the live
 *                             SCORER_CONFIG_VERSION); an earlier epoch's
 *                             trades, epoch_end closes included, stay
 *                             readable this way
 *   --json                    one JSON line per book instead of a table
 *   --mongo-uri <uri>         connect here instead of MONGODB_URI
 */
import { connectDB } from '@/lib/mongodb';
import { PaperBook } from '@/lib/models/paper-book';
import { PaperLedger } from '@/lib/models/paper-ledger';
import { PaperTrade, type IPaperTrade } from '@/lib/models/paper-trade';
import { DESK_BOOKS, parseBookId, type BookKey } from '@/lib/paper-desk/books';
import { buildBookReport, type BookReport } from '@/lib/paper-desk/report';
import { SCORER_CONFIG_VERSION } from '@/lib/signals/config-version';

export { buildBookReport, trackStats, type BookReport, type TrackStats } from '@/lib/paper-desk/report';

export interface ParsedArgs {
  book: BookKey | null;
  symbol: string | null;
  since: Date | null;
  /** The scorer configVersion whose trades are read. */
  configVersion: number;
  json: boolean;
  mongoUri: string | null;
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/** Pure argv parser: no I/O, so it is unit tested directly. */
export function parseArgs(argv: string[]): ParsedArgs {
  let book: BookKey | null = null;
  let symbol: string | null = null;
  let since: Date | null = null;
  let configVersion = SCORER_CONFIG_VERSION;
  let json = false;
  let mongoUri: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--book':
        book = parseBookId(nextValue(argv, ++i, '--book'));
        break;
      case '--symbol':
        symbol = nextValue(argv, ++i, '--symbol');
        break;
      case '--since': {
        const value = nextValue(argv, ++i, '--since');
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) throw new Error(`--since: invalid date "${value}"`);
        since = parsed;
        break;
      }
      case '--config-version': {
        const value = nextValue(argv, ++i, '--config-version');
        if (!/^\d+$/.test(value)) throw new Error(`--config-version: expected a positive integer, got "${value}"`);
        configVersion = Number(value);
        break;
      }
      case '--json':
        json = true;
        break;
      case '--mongo-uri':
        mongoUri = nextValue(argv, ++i, '--mongo-uri');
        break;
      default:
        throw new Error(`Unknown flag "${flag}"`);
    }
  }

  return { book, symbol, since, configVersion, json, mongoUri };
}

function pct(value: number | null, digits = 4): string {
  return value === null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

export function formatReport(reports: BookReport[], json: boolean): string {
  if (json) return reports.map((r) => JSON.stringify(r)).join('\n');

  const lines: string[] = [];
  for (const r of reports) {
    lines.push('');
    lines.push(`=== ${r.book} ===`);
    if (r.trades === 0) {
      lines.push(
        `  no closed trades yet; ${r.openPositions} open, ${r.symbols} ledgers, ${r.missingScoreBars} unscored bars`
      );
      continue;
    }
    const e = r.engine!;
    lines.push(
      `  engine      n=${e.trades} exp=${pct(e.expectancyPercent)} CI95=[${pct(e.ciLowPercent)}, ${pct(
        e.ciHighPercent
      )}] win=${(e.winRate * 100).toFixed(1)}% pnl=${e.totalPnl.toFixed(2)}`
    );
    if (r.executable) {
      const x = r.executable;
      lines.push(
        `  executable  n=${x.trades} exp=${pct(x.expectancyPercent)} CI95=[${pct(x.ciLowPercent)}, ${pct(
          x.ciHighPercent
        )}] win=${(x.winRate * 100).toFixed(1)}% pnl=${x.totalPnl.toFixed(2)}`
      );
    }
    lines.push(
      `  lag cost    ${pct(r.lagCostPercent)} per trade (engine minus executable; the engine fills at the signal close, a live order cannot)`
    );
    lines.push(
      `  recorded    ${pct(r.recordedExpectancyPercent, 4)} (${r.evidenceStatus}) from the research control at this interval`
    );
    lines.push(
      `  exits       ${Object.entries(r.byReason)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}`
    );
    lines.push(
      `  execution   gapped stops=${r.gappedStops} stopped on arrival=${r.stoppedOnArrival} unfilled=${r.unfilled}`
    );
    lines.push(
      `  equity      engine=${r.equity.toFixed(2)} executable=${r.executableEquity.toFixed(
        2
      )} of ${r.startEquity.toFixed(2)} start, peak leverage=${r.peakLeverage.toFixed(2)}x`
    );
    lines.push(`  bars        ${r.missingScoreBars} stepped with at least one symbol unscored`);
  }
  lines.push('');
  lines.push('Win rate is reported, never targeted. Books are never pooled.');
  return lines.join('\n');
}

export async function runPaperDeskOutcomes(args: ParsedArgs): Promise<BookReport[]> {
  const keys = args.book ? [args.book] : [...DESK_BOOKS];
  const reports: BookReport[] = [];

  for (const key of keys) {
    const filter: Record<string, unknown> = { tradingStyle: key.tradingStyle, interval: key.interval };
    if (args.symbol) filter.symbol = args.symbol;
    if (args.since) filter.exitTime = { $gte: args.since.getTime() };
    filter.entryConfigVersion = args.configVersion;

    const trades = await PaperTrade.find(filter).sort({ exitTime: 1 }).lean<IPaperTrade[]>();
    const ledgerFilter: Record<string, unknown> = {
      tradingStyle: key.tradingStyle,
      interval: key.interval,
    };
    if (args.symbol) ledgerFilter.symbol = args.symbol;
    const ledgers = await PaperLedger.find(ledgerFilter).lean();
    const book = await PaperBook.findOne({
      tradingStyle: key.tradingStyle,
      interval: key.interval,
    }).lean();

    reports.push(buildBookReport(key, trades, ledgers, book));
  }

  return reports;
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.mongoUri) process.env.MONGODB_URI = args.mongoUri;
    await connectDB();
    const reports = await runPaperDeskOutcomes(args);
    console.log(formatReport(reports, args.json));
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
