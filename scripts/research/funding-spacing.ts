/**
 * Per symbol and calendar year: do an exported dataset's funding settlements
 * arrive at the spacing the archive says they do, where did the settlement
 * interval switch, and how is the settled rate distributed?
 *
 * Why it exists: the funding carry test (review 2026-10-01) collects every
 * settlement a position crosses. `funding.ts` hard-codes an 8h grid, and a
 * symbol Binance moved to a 4h interval would be undercounted by any code that
 * assumes it. This reads the per-settlement `funding` dataset kind and says,
 * before any carry number is trusted, whether that assumption ever breaks.
 *
 * Usage:
 *   npx tsx scripts/research/funding-spacing.ts --dataset-dir <dir> [--symbols A,B] [--json]
 *
 * Lockbox: applied (rows from 2026-07-01 are dropped), as for every research read.
 */
import { loadFunding } from './load-dataset';
import { settlementSpacingReport, type SpacingYearRow } from '@/lib/funding-settlements';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

export interface SpacingArgs {
  datasetDir: string;
  symbols: string[];
  json: boolean;
}

export function parseArgs(argv: string[]): SpacingArgs {
  let datasetDir = 'data/research';
  let symbols: string[] = [...SIGNAL_SYMBOLS];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') {
      json = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--dataset-dir') datasetDir = value;
    else if (flag === '--symbols') symbols = value.split(',').map((s) => s.trim()).filter(Boolean);
    else throw new Error(`Unknown flag ${flag}`);
    i++;
  }
  return { datasetDir, symbols, json };
}

export function formatSpacing(bySymbol: Record<string, SpacingYearRow[]>): string {
  const lines: string[] = [];
  lines.push(
    ['symbol', 'year', 'n', 'mismatch', 'missing', 'switches', 'intervals', 'min%', 'max%', 'base share', 'at extreme']
      .map((h) => h.padEnd(11))
      .join('')
  );
  for (const [symbol, rows] of Object.entries(bySymbol)) {
    for (const r of rows) {
      const intervals = Object.entries(r.byInterval)
        .map(([h, n]) => `${h}h:${n}`)
        .join(' ');
      lines.push(
        [
          symbol,
          String(r.year),
          String(r.settlements),
          String(r.spacingMismatches),
          String(r.missingSpan),
          String(r.intervalSwitches),
          intervals,
          (r.minRate * 100).toFixed(4),
          (r.maxRate * 100).toFixed(4),
          r.baseRateShare.toFixed(3),
          String(r.atExtreme),
        ]
          .map((c) => c.padEnd(11))
          .join('')
      );
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bySymbol: Record<string, SpacingYearRow[]> = {};
  for (const symbol of args.symbols) {
    const { rows } = loadFunding(args.datasetDir, symbol);
    bySymbol[symbol] = settlementSpacingReport(rows);
  }
  console.log(args.json ? JSON.stringify(bySymbol, null, 2) : formatSpacing(bySymbol));
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
