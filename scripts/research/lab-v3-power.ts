import { readFileSync } from 'node:fs';
import { runPowerSimulation } from './nv2-preview';

/**
 * Shifts return series R to have the specified annual Sharpe ratio.
 * Formula: R - mean + annualSharpe * sd / sqrt(365), with sd as sample SD (n - 1).
 */
export function shiftToSharpe(R: number[], annualSharpe: number): number[] {
  const n = R.length;
  if (n <= 1) return [...R];
  const mean = R.reduce((acc, v) => acc + v, 0) / n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = R[i] - mean;
    sumSq += d * d;
  }
  const variance = sumSq / (n - 1);
  const sd = Math.sqrt(variance);
  const targetShift = (annualSharpe * sd) / Math.sqrt(365);
  return R.map((r) => r - mean + targetShift);
}

/**
 * Counts tail events for a return series R relative to scale c:
 * belowMinus1: R / c < -1
 * belowMinus2: R / c < -2
 * gainClipped: R / c > 1
 */
export function tailCounts(
  R: number[],
  c: number
): { belowMinus1: number; belowMinus2: number; gainClipped: number } {
  let belowMinus1 = 0;
  let belowMinus2 = 0;
  let gainClipped = 0;

  for (let i = 0; i < R.length; i++) {
    const x = R[i] / c;
    if (x < -1) belowMinus1++;
    if (x < -2) belowMinus2++;
    if (x > 1) gainClipped++;
  }

  return { belowMinus1, belowMinus2, gainClipped };
}

interface CliArgs {
  preview: string;
  series: string;
}

function parseArgs(argv: string[]): CliArgs {
  let preview = '';
  let series = 'fund7_h7';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--preview' && i + 1 < argv.length) {
      preview = argv[++i];
    } else if (arg.startsWith('--preview=')) {
      preview = arg.slice('--preview='.length);
    } else if (arg === '--series' && i + 1 < argv.length) {
      series = argv[++i];
    } else if (arg.startsWith('--series=')) {
      series = arg.slice('--series='.length);
    }
  }

  if (!preview) {
    throw new Error('--preview <preview.json> is required');
  }

  return { preview, series };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const raw = readFileSync(args.preview, 'utf8');
  const json = JSON.parse(raw) as {
    series?: Record<string, Array<{ D: string; R: number }>>;
  };

  const seriesItems = json.series?.[args.series];
  if (!seriesItems || !Array.isArray(seriesItems)) {
    throw new Error(`Series "${args.series}" not found in ${args.preview}`);
  }

  const R = seriesItems.map((item) => item.R);
  const n = R.length;
  if (n === 0) {
    throw new Error(`Series "${args.series}" has 0 items`);
  }

  const mean = R.reduce((acc, v) => acc + v, 0) / n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = R[i] - mean;
    sumSq += d * d;
  }
  const variance = n > 1 ? sumSq / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const annualSharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
  const min = Math.min(...R);

  const sortedItems = [...seriesItems].sort((a, b) => a.R - b.R);
  const worst5Days = sortedItems.slice(0, 5).map((item) => ({ D: item.D, R: item.R }));

  // Print one JSON line with summary
  console.log(
    JSON.stringify({
      n,
      mean,
      sd,
      annualSharpe,
      min,
      worst5Days,
    })
  );

  const scales = [0.036, 0.1];
  const targets: Array<'measured' | number> = ['measured', 0, 1, 1.5, 2, 2.5];

  for (const c of scales) {
    const tc = tailCounts(R, c);
    console.log(`c = ${c} tail counts:`, JSON.stringify(tc));

    for (const target of targets) {
      const shifted = target === 'measured' ? R : shiftToSharpe(R, target);
      const sim = runPowerSimulation(shifted, c, 42);
      const iid = sim.iid[200];
      const block = sim.block[200];
      console.log(
        `c = ${c}, target = ${target}: iid share ${(iid.share * 100).toFixed(1)}% (median bar ${iid.medianBar}), block share ${(block.share * 100).toFixed(1)}% (median bar ${block.medianBar})`
      );
    }
  }

  process.exit(0);
}

const isDirectRun =
  (typeof require !== 'undefined' && require.main === module) ||
  (typeof process !== 'undefined' &&
    process.argv[1] &&
    process.argv[1].endsWith('lab-v3-power.ts'));

if (isDirectRun) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
