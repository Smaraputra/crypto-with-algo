/**
 * Builds the broad trend phase's point-in-time universe file from an export.
 *
 *   npx tsx scripts/research/broad-universe.ts --dataset-dir <export> --out <universe.json>
 *
 * Reads only the export's 1d perp klines (lockbox applied), verifies the
 * manifest's hashes first, segments every symbol into contracts, ranks them at
 * each month close (broad-trend.ts) and writes the memberships with the
 * export's hash and the file's own sha256. It computes no return, signal or
 * strategy statistic.
 */
import { writeFileSync } from 'node:fs';

import { segmentContracts, universeFile, type Contract } from './broad-trend';
import { loadManifest, loadPerp, verifyManifest } from './load-dataset';

export interface ParsedArgs {
  datasetDir: string;
  out: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let datasetDir: string | null = null;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--dataset-dir' || flag === '--out') {
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      if (flag === '--dataset-dir') datasetDir = value;
      else out = value;
      i++;
    } else {
      throw new Error(`Unknown flag ${flag}`);
    }
  }
  if (!datasetDir) throw new Error('--dataset-dir is required');
  if (!out) throw new Error('--out is required');
  return { datasetDir, out };
}

/** Symbols with a 1d perp klines file in the manifest, sorted. */
export function perpDailySymbols(files: ReadonlyArray<{ kind: string; interval: string; path: string; symbol: string }>): string[] {
  return [
    ...new Set(
      files.filter((f) => f.kind === 'perp' && f.interval === '1d' && f.path.endsWith('/1d.jsonl.gz')).map((f) => f.symbol)
    ),
  ].sort();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const check = await verifyManifest(args.datasetDir);
  if (!check.ok) throw new Error(`Manifest verification failed: ${check.mismatches.join(', ')}`);
  const manifest = loadManifest(args.datasetDir);

  const contracts: Contract[] = [];
  for (const symbol of perpDailySymbols(manifest.files)) {
    const { rows } = loadPerp(args.datasetDir, symbol, '1d');
    contracts.push(...segmentContracts(symbol, rows));
  }

  const file = universeFile({ sourceDatasetHash: manifest.datasetHash, contracts });
  writeFileSync(args.out, `${JSON.stringify(file, null, 1)}\n`);
  const last = file.countsPerMonth[file.countsPerMonth.length - 1];
  console.log(
    JSON.stringify({
      out: args.out,
      sha256: file.sha256,
      sourceDatasetHash: file.sourceDatasetHash,
      contracts: file.contracts.length,
      startClose: file.universe.startClose,
      startLaterThan20210701: file.universe.startLaterThan20210701,
      months: file.universe.months.length,
      lastMonth: last ?? null,
    })
  );
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
