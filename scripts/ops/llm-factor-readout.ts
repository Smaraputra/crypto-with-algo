/**
 * Reads the LLM panel's live record as a cross-sectional factor.
 *
 * This is the companion to `live-outcomes.ts --source llm`, not a replacement.
 * That script answers "what would trading these tiers have returned", which is
 * the right question for a desk. This one answers "did the panel rank the
 * cross-section", which is the only question a ten-symbol, forward-only factor
 * of this size can actually support -- and it refuses to answer it when the
 * sample cannot.
 *
 * Two corrections it applies that a per-tier read does not (see
 * llm-factor-stats.ts for the reasoning):
 *
 *   - the cross-sectional mean return is removed per bar, because on the first
 *     resolved window EVERY tier had a positive mean return, `sell` included,
 *     simply because the market rose about 3% over the horizon;
 *   - bars are converted to non-overlapping forward windows, because 1h calls
 *     posted two-hourly against a 24-bar horizon share ~22 of those 24 bars
 *     with their neighbours. The first read of this record looked like
 *     t = -2.76 on 15 bars; corrected, that is about one independent
 *     observation, and the script says so rather than printing the t alone.
 *
 * Forward-only, as the program requires: it reads `SignalOutcome` rows the
 * resolver has already settled and computes nothing the panel could have seen.
 * It is a measurement of the record, not a backtest of the panel, and it must
 * never be used to select or tune a prompt version.
 *
 * Runs inside the seeder image against production, as live-outcomes.ts does:
 *
 *   docker build --target seeder -t crypto-ops:llm .
 *   docker run --rm --network crypto_crypto-internal --env-file .env \
 *     crypto-ops:llm npx tsx scripts/ops/llm-factor-readout.ts
 *
 * Or locally against a synced database:
 *
 *   npx tsx scripts/ops/llm-factor-readout.ts \
 *     --mongo-uri mongodb://localhost:27017/cryptowithalgo
 *
 * Flags:
 *   --interval <a,b,...>   default 1h,4h,1d
 *   --prompt-version <n>   only calls from this promptVersion number
 *   --min-cross-section <n>  narrowest bar worth demeaning, default 3
 *   --mongo-uri <uri>      override MONGODB_URI, set before connectDB()
 *   --json                 one JSON object instead of the table
 */
import { LLM_CALL_INTERVALS, llmStyleForInterval } from '@/lib/models/llm-call';
import { OUTCOME_HORIZON_BARS } from '@/lib/signals/outcome-horizons';
import { panelIcStats, type PanelIcStats, type PanelObservation } from './llm-factor-stats';

export interface ParsedArgs {
  intervals: string[];
  promptVersion: number | undefined;
  minCrossSection: number;
  mongoUri: string | undefined;
  json: boolean;
}

export interface IntervalReadout extends PanelIcStats {
  interval: string;
  horizonBars: number;
  /** Mean raw forward return across kept observations: the market's contribution. */
  meanForwardPercent: number;
  firstBar: string | null;
  lastBar: string | null;
}

export interface LlmFactorReport {
  generatedAt: string;
  promptVersion: number | undefined;
  minCrossSection: number;
  intervals: IntervalReadout[];
}

const DEFAULT_INTERVALS = [...LLM_CALL_INTERVALS];

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    intervals: DEFAULT_INTERVALS,
    promptVersion: undefined,
    minCrossSection: 3,
    mongoUri: undefined,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];

    switch (flag) {
      case '--interval':
      case '--intervals': {
        const requested = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const unknown = requested.filter((r) => !DEFAULT_INTERVALS.includes(r as never));
        if (requested.length === 0 || unknown.length > 0) {
          throw new Error(`--interval must be a comma list of ${DEFAULT_INTERVALS.join(',')}`);
        }
        args.intervals = requested;
        i++;
        break;
      }
      case '--prompt-version': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new Error('--prompt-version must be a positive integer');
        args.promptVersion = n;
        i++;
        break;
      }
      case '--min-cross-section': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 3) {
          // Below three, demeaning leaves +d/-d and the IC is +/-1 by construction.
          throw new Error('--min-cross-section must be an integer of at least 3');
        }
        args.minCrossSection = n;
        i++;
        break;
      }
      case '--mongo-uri':
        if (!value) throw new Error('--mongo-uri needs a value');
        args.mongoUri = value;
        i++;
        break;
      case '--json':
        args.json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return args;
}

/** Injected so the report is testable without Mongo, as inputs/packet.ts does. */
export interface ReadoutDeps {
  loadResolved: (interval: string, promptVersion: number | undefined) => Promise<PanelObservation[]>;
}

export async function runLlmFactorReadout(
  deps: ReadoutDeps,
  args: Pick<ParsedArgs, 'intervals' | 'promptVersion' | 'minCrossSection'>,
  now: number
): Promise<LlmFactorReport> {
  const intervals: IntervalReadout[] = [];

  for (const interval of args.intervals) {
    const observations = await deps.loadResolved(interval, args.promptVersion);
    const horizonBars = OUTCOME_HORIZON_BARS[llmStyleForInterval(interval)];
    const stats = panelIcStats(observations, horizonBars, args.minCrossSection);

    const bars = observations.map((o) => o.candleTimestamp).sort((a, b) => a - b);
    const meanForwardPercent =
      observations.length > 0
        ? observations.reduce((s, o) => s + o.forwardReturnPercent, 0) / observations.length
        : NaN;

    intervals.push({
      ...stats,
      interval,
      horizonBars,
      meanForwardPercent,
      firstBar: bars.length > 0 ? new Date(bars[0]).toISOString() : null,
      lastBar: bars.length > 0 ? new Date(bars[bars.length - 1]).toISOString() : null,
    });
  }

  return {
    generatedAt: new Date(now).toISOString(),
    promptVersion: args.promptVersion,
    minCrossSection: args.minCrossSection,
    intervals,
  };
}

const fmt = (v: number, digits = 4) => (Number.isFinite(v) ? v.toFixed(digits) : 'n/a');

export function formatReport(report: LlmFactorReport, json: boolean): string {
  if (json) return JSON.stringify(report);

  const lines: string[] = [];
  lines.push(
    `llm factor readout  generatedAt=${report.generatedAt}` +
      (report.promptVersion ? ` promptVersion=v${report.promptVersion}` : '') +
      ` minCrossSection=${report.minCrossSection}`
  );

  for (const r of report.intervals) {
    lines.push('');
    lines.push(
      `interval=${r.interval} horizonBars=${r.horizonBars} calls=${r.n} bars=${r.bars} ` +
        `independentWindows=${fmt(r.independentWindows, 2)}`
    );
    if (r.firstBar) lines.push(`  range=${r.firstBar}..${r.lastBar}`);
    lines.push(
      `  demeanedIC=${fmt(r.demeanedIc)}  rawIC=${fmt(r.rawIc)}  ` +
        `meanBarIC=${fmt(r.meanBarIc)}  barsPositive=${fmt(r.barsPositive, 2)}`
    );
    // Printed together on purpose: the t and the factor by which it is
    // overstated must never appear apart.
    const inflation = Number.isFinite(r.inflationFactor)
      ? `~${r.inflationFactor.toFixed(1)}x`
      : 'n/a';
    const marketMean = Number.isFinite(r.meanForwardPercent)
      ? `${r.meanForwardPercent.toFixed(2)}%`
      : 'n/a';
    lines.push(`  naiveT=${fmt(r.naiveT, 2)}  inflatedBy=${inflation}  marketMeanFwd=${marketMean}`);
    lines.push(`  ${r.verdict}`);
  }

  lines.push('');
  lines.push(
    'note: demeanedIC removes each bar\'s cross-sectional mean return, so it measures ranking ' +
      'within the panel rather than market direction; rawIC leaves the market in. Forward-only ' +
      'measurement of the settled record -- never a backtest, and never an input to prompt selection.'
  );

  return lines.join('\n');
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.mongoUri) {
      process.env.MONGODB_URI = args.mongoUri;
    }

    const { connectDB } = await import('@/lib/mongodb');
    const { SignalOutcome } = await import('@/lib/models/signal-outcome');
    await connectDB();

    const deps: ReadoutDeps = {
      loadResolved: async (interval, promptVersion) => {
        const filter: Record<string, unknown> = {
          source: 'llm',
          status: 'resolved',
          interval,
        };
        if (promptVersion !== undefined) filter.configVersion = promptVersion;

        const rows = (await SignalOutcome.find(filter)
          .select('symbol candleTimestamp score forwardReturnPercent')
          .lean()) as unknown as PanelObservation[];

        return rows.map((r) => ({
          symbol: r.symbol,
          candleTimestamp: r.candleTimestamp,
          score: r.score,
          forwardReturnPercent: r.forwardReturnPercent,
        }));
      },
    };

    const report = await runLlmFactorReadout(deps, args, Date.now());
    console.log(formatReport(report, args.json));
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
