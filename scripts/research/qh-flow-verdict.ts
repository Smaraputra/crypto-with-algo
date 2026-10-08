/**
 * QH-FLOW verdict: applies the locked survivor rule, AMENDMENT 1 (A1-2, A1-3,
 * A1-4) and the kill criteria of qh-flow.ts to the two HOLD-OUT factor-ic
 * reports and the two null-only floor reports. Nothing else reads the reports.
 *
 * Usage:
 *   npx tsx scripts/research/qh-flow-verdict.ts --report-1h a.json --report-4h b.json \
 *     --floor-1h c.json --floor-4h d.json [--out verdict.json]
 *
 * Before applying the rule it asserts (and throws on any failure) that all four
 * files carry one dataset manifest hash, execution lag 1, perp returns, the
 * locked hold-out window, exactly the four qh-flow columns, exactly the locked
 * horizons (1,4,8,12 at 1h and 1,2,3 at 4h) and exactly 28 pooled cells, so the
 * Benjamini-Hochberg family cannot be widened by running without --factors.
 *
 * Then, in this order:
 * 1. survivor-table's rule, unchanged (|ic| >= 0.02, |t| >= 3.15 at >= 2
 *    horizons, 60% of quarters, 7 of 10 symbols), with BH q 0.10 over the 28
 *    cells, through report-schema.ts's exported evaluatePhaseSurvivors and
 *    evaluateSurvivors (not reimplemented).
 * 2. A1-3: for a predicted column only horizons with the PREDICTED sign count,
 *    and raw.qhOpenImb at 1h h1 never counts. Horizons that fail are removed
 *    before the two-horizon, quarter and symbol legs are evaluated.
 * 3. A1-2: at the counted horizons |ic| must be at least that cell's detection
 *    floor from the null-only report.
 *
 * The negative control raw.fiveMinOpenImb has no predicted sign and no floor
 * leg: it is judged by the unrestricted rule, in either sign, so the control
 * trips as easily as the rule allows.
 *
 * Verdict: SUSPECT (kill criterion 1: the control survives at either interval),
 * else NULL (kill criterion 2: none of qhOpenImb, largeTakerImb, smallTakerImb
 * survives with its predicted sign at either interval), else SURVIVOR (the
 * harness amendment may be written; this script never runs it).
 */
import { readFile, writeFile } from 'fs/promises';
import { intervalToMs } from '@/lib/intervals';
import {
  evaluatePhaseSurvivors,
  evaluateSurvivors,
  PHASE_FDR_Q,
  validateFactorIcReport,
  type FactorIcReport,
  type FactorReport,
  type SurvivorRow,
} from './report-schema';
import { NULL_REPORT_KIND, QH_FLOW_FACTORS, QH_FLOW_HORIZONS, type NullReport } from './qh-flow-null';
import { QH_FLOW_HOLDOUT, QH_FLOW_PREDICTED_SIGN } from './qh-flow';

export const VERDICT_INTERVALS = ['1h', '4h'] as const;
export type VerdictInterval = (typeof VERDICT_INTERVALS)[number];
export const EXPECTED_POOLED_CELLS = 28;
/** The negative control column. */
export const CONTROL_FACTOR = 'raw.fiveMinOpenImb';
const BOOTSTRAP_ITERATIONS = 200;
const BOOTSTRAP_SEED = 42;

export interface VerdictInputs {
  reports: Record<VerdictInterval, FactorIcReport>;
  floors: Record<VerdictInterval, NullReport>;
}

export interface HorizonDiagnostic {
  horizon: number;
  ic: number;
  t: number;
  floorIc: number;
  clearsRule: boolean;
  fdrRejected: boolean;
  /** Why the horizon does not count toward a predicted column, or null when it can. */
  excluded: string | null;
}

export interface IntervalVerdict {
  survives: boolean;
  /** Horizons that count and pass (empty for a column that does not survive). */
  horizonsPassing: number[];
  reasons: string[];
  horizons: HorizonDiagnostic[];
}

export interface ColumnVerdict {
  predictedSign: number;
  survivesAnywhere: boolean;
  byInterval: Record<VerdictInterval, IntervalVerdict>;
}

export interface Verdict {
  verdict: 'SUSPECT' | 'NULL' | 'SURVIVOR';
  killCriterion1: { triggered: boolean; description: string };
  killCriterion2: { triggered: boolean; description: string };
  datasetManifestHash: string;
  window: { start: string; end: string };
  pooledCells: number;
  fdr: { q: number; rejectedCells: number };
  columns: Record<string, ColumnVerdict>;
}

const FACTORS = QH_FLOW_FACTORS;

function same(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Throws unless every precondition of the locked family holds. */
export function assertVerdictInputs(inputs: VerdictInputs): void {
  const hold = { start: Date.parse(QH_FLOW_HOLDOUT.start), end: Date.parse(QH_FLOW_HOLDOUT.end) };
  const hashes = new Set<string>();
  const taskIds = new Set<string>();
  let cells = 0;

  for (const interval of VERDICT_INTERVALS) {
    const report = inputs.reports[interval];
    const floor = inputs.floors[interval];
    const horizons = QH_FLOW_HORIZONS[interval];
    const label = `${interval} report`;
    const fail = (what: string): never => {
      throw new Error(`qh-flow verdict: ${label}: ${what}`);
    };

    hashes.add(report.datasetManifestHash);
    hashes.add(floor.datasetManifestHash);
    if (taskIds.has(report.taskId)) fail(`duplicate taskId ${report.taskId}`);
    taskIds.add(report.taskId);

    if (report.interval !== interval) fail(`interval is ${report.interval}`);
    if (report.executionLagBars !== 1) fail(`execution lag is ${report.executionLagBars}, need 1`);
    if (report.returnSeries !== 'perp') fail(`return series is ${report.returnSeries ?? 'spot'}, need perp`);
    if (report.crossSectionalDemean) fail('cross-sectional demean run, need the pooled statistic');
    if (report.bootstrap.iterations !== BOOTSTRAP_ITERATIONS || report.bootstrap.seed !== BOOTSTRAP_SEED) {
      fail(`bootstrap is ${report.bootstrap.iterations}/${report.bootstrap.seed}, need 200/42`);
    }
    const intervalMs = intervalToMs(interval);
    if (
      report.dateRange.startMs !== hold.start ||
      report.dateRange.endMs > hold.end ||
      report.dateRange.endMs <= hold.end - intervalMs
    ) {
      fail(
        `window ${new Date(report.dateRange.startMs).toISOString()}..${new Date(report.dateRange.endMs).toISOString()} ` +
          `is not the locked hold-out ${QH_FLOW_HOLDOUT.start}..${QH_FLOW_HOLDOUT.end}`
      );
    }
    if (!same(report.horizons, horizons)) fail(`horizons ${report.horizons.join(',')} differ from ${horizons.join(',')}`);
    if (!same([...report.factors.map((f) => f.name)].sort(), [...FACTORS].sort())) {
      fail(`factors ${report.factors.map((f) => f.name).join(',')} are not exactly the four qh-flow columns`);
    }
    for (const factor of report.factors) {
      if (!same(factor.pooled.horizons.map((h) => h.horizon), horizons)) {
        fail(`${factor.name} pooled horizons ${factor.pooled.horizons.map((h) => h.horizon).join(',')} differ from ${horizons.join(',')}`);
      }
      cells += factor.pooled.horizons.length;
    }

    const ffail = (what: string): never => {
      throw new Error(`qh-flow verdict: ${interval} floor report: ${what}`);
    };
    if (floor.reportKind !== NULL_REPORT_KIND) ffail(`not a ${NULL_REPORT_KIND} report`);
    if (floor.args.nullOnly !== true) ffail('not a null-only report');
    if (floor.args.interval !== interval) ffail(`interval is ${floor.args.interval}`);
    if (floor.args.executionLagBars !== 1) ffail(`execution lag is ${floor.args.executionLagBars}, need 1`);
    if (floor.args.returnSeries !== 'perp') ffail(`return series is ${floor.args.returnSeries}, need perp`);
    if (floor.args.draws !== 200) ffail(`draws is ${floor.args.draws}, need 200`);
    if (floor.args.seed !== 7) ffail(`seed is ${floor.args.seed}, need 7`);
    if (floor.args.minShiftDays !== 30) ffail(`minShiftDays is ${floor.args.minShiftDays}, need 30`);
    if (floor.args.start !== hold.start || floor.args.end !== hold.end) ffail('window is not the locked hold-out');
    if (!same(floor.args.horizons, horizons)) ffail(`horizons ${floor.args.horizons.join(',')} differ`);
    if (!same([...floor.args.factors].sort(), [...FACTORS].sort())) ffail('factors are not exactly the four columns');
    for (const factor of FACTORS) {
      for (const h of horizons) {
        const cell = floor.cells.find((c) => c.factor === factor && c.horizon === h);
        if (!cell || !Number.isFinite(cell.detectionFloorIc)) ffail(`no finite detection floor for ${factor} h${h}`);
      }
    }
  }

  if (hashes.size !== 1) {
    throw new Error(`qh-flow verdict: the four files carry ${hashes.size} dataset manifest hashes, need one`);
  }
  if (cells !== EXPECTED_POOLED_CELLS) {
    throw new Error(`qh-flow verdict: ${cells} pooled cells, need exactly ${EXPECTED_POOLED_CELLS}`);
  }
}

function predictedSignOf(factor: string): number {
  return (QH_FLOW_PREDICTED_SIGN as Record<string, number>)[factor];
}

/** Applies the verdict. Throws on a failed assertion; see the header for the order of the rules. */
export function computeVerdict(inputs: VerdictInputs): Verdict {
  assertVerdictInputs(inputs);
  const reports = VERDICT_INTERVALS.map((i) => inputs.reports[i]);

  // Step 1: the unchanged rule and the 28-cell Benjamini-Hochberg family.
  const table = evaluatePhaseSurvivors(reports, PHASE_FDR_Q);
  const unrestricted = (interval: VerdictInterval, factor: string): SurvivorRow => {
    const taskId = inputs.reports[interval].taskId;
    return table.rows.find((r) => r.taskId === taskId && r.factor === factor)!;
  };

  const floorOf = (interval: VerdictInterval, factor: string, h: number): number =>
    inputs.floors[interval].cells.find((c) => c.factor === factor && c.horizon === h)!.detectionFloorIc;

  const columns: Record<string, ColumnVerdict> = {};
  for (const factor of FACTORS) {
    const sign = predictedSignOf(factor);
    const byInterval = {} as Record<VerdictInterval, IntervalVerdict>;

    for (const interval of VERDICT_INTERVALS) {
      const report = inputs.reports[interval];
      const fullRow = unrestricted(interval, factor);
      const factorReport = report.factors.find((f) => f.name === factor)!;
      const fdrRejected = new Set(fullRow.horizonsPassing);

      const diagnostics: HorizonDiagnostic[] = factorReport.pooled.horizons.map((h) => {
        const floorIc = floorOf(interval, factor, h.horizon);
        const clearsRule = Math.abs(h.ic) >= 0.02 && Math.abs(h.icT) >= 3.15;
        let excluded: string | null = null;
        if (sign !== 0) {
          if (factor === 'raw.qhOpenImb' && interval === '1h' && h.horizon === 1) {
            excluded = 'no prediction at 1h h1 (A1-3)';
          } else if (Math.sign(h.ic) !== sign) {
            excluded = `sign ${Math.sign(h.ic) > 0 ? '+' : Math.sign(h.ic) < 0 ? '-' : '0'} is not the predicted ${sign > 0 ? '+' : '-'} (A1-3)`;
          }
        }
        return {
          horizon: h.horizon,
          ic: h.ic,
          t: h.icT,
          floorIc,
          clearsRule,
          fdrRejected: fdrRejected.has(h.horizon),
          excluded,
        };
      });

      if (sign === 0) {
        // The control: unrestricted rule, either sign, no floor leg.
        byInterval[interval] = {
          survives: fullRow.survivor,
          horizonsPassing: fullRow.survivor ? fullRow.horizonsPassing : [],
          reasons: fullRow.reasons,
          horizons: diagnostics,
        };
        continue;
      }

      // Steps 2 and 3: keep only the horizons that count, then check if all pass the floor.
      const counted = new Set(diagnostics.filter((d) => d.excluded === null).map((d) => d.horizon));

      // Check if all counted horizons that pass the basic rule also pass the floor (A1-2 strict rule).
      // Only horizons with |ic| >= 0.02 pass the basic rule.
      const rulePassers = diagnostics.filter((d) => counted.has(d.horizon) && d.clearsRule);
      const floorFailures = rulePassers.filter((d) => !(Math.abs(d.ic) >= d.floorIc));

      if (rulePassers.length > 0 && floorFailures.length > 0) {
        // Column fails if any rule-passing horizon is below its floor.
        const reasons = floorFailures.map(
          (d) => `h${d.horizon}: |ic| ${Math.abs(d.ic).toFixed(5)} is below the detection floor ${d.floorIc.toFixed(5)} (A1-2)`
        );
        // Update diagnostics to mark floor failures.
        const updated = diagnostics.map((d) => {
          if (floorFailures.find((f) => f.horizon === d.horizon)) {
            return {
              ...d,
              excluded: `|ic| ${Math.abs(d.ic).toFixed(5)} is below the detection floor ${d.floorIc.toFixed(5)} (A1-2)`,
            };
          }
          return d;
        });
        byInterval[interval] = {
          survives: false,
          horizonsPassing: [],
          reasons,
          horizons: updated,
        };
      } else {
        const restricted: FactorReport = {
          ...factorReport,
          pooled: { horizons: factorReport.pooled.horizons.filter((h) => counted.has(h.horizon)) },
        };
        const row = evaluateSurvivors(
          { ...report, factors: [restricted] },
          (_name, horizon) => fdrRejected.has(horizon)
        )[0];
        const reasons = [...row.reasons];
        for (const d of diagnostics) {
          if (d.excluded) reasons.push(`h${d.horizon}: ${d.excluded}`);
        }
        byInterval[interval] = {
          survives: row.survivor,
          horizonsPassing: row.survivor ? row.horizonsPassing : [],
          reasons: row.survivor ? [] : reasons,
          horizons: diagnostics,
        };
      }
    }

    columns[factor] = {
      predictedSign: sign,
      survivesAnywhere: VERDICT_INTERVALS.some((i) => byInterval[i].survives),
      byInterval,
    };
  }

  const controlTriggered = columns[CONTROL_FACTOR].survivesAnywhere;
  const predicted = FACTORS.filter((f) => predictedSignOf(f) !== 0);
  const noPredictedSurvivor = predicted.every((f) => !columns[f].survivesAnywhere);
  const verdict: Verdict['verdict'] = controlTriggered ? 'SUSPECT' : noPredictedSurvivor ? 'NULL' : 'SURVIVOR';

  return {
    verdict,
    killCriterion1: {
      triggered: controlTriggered,
      description: `${CONTROL_FACTOR} survives on the hold-out in either sign: the measurement is suspect, stop and diagnose`,
    },
    killCriterion2: {
      triggered: !controlTriggered && noPredictedSurvivor,
      description: `none of ${predicted.join(', ')} survives with its predicted sign: the phase closes with a null, no harness run`,
    },
    datasetManifestHash: inputs.reports['1h'].datasetManifestHash,
    window: { start: QH_FLOW_HOLDOUT.start, end: QH_FLOW_HOLDOUT.end },
    pooledCells: table.cells,
    fdr: { q: PHASE_FDR_Q, rejectedCells: table.rejectedCells },
    columns,
  };
}

const VALUE_FLAGS = new Set(['report-1h', 'report-4h', 'floor-1h', 'floor-4h', 'out']);

export interface VerdictArgs {
  report1h: string;
  report4h: string;
  floor1h: string;
  floor4h: string;
  out?: string;
}

export function parseVerdictArgs(argv: string[]): VerdictArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (!VALUE_FLAGS.has(key)) throw new Error(`Unknown flag --${key}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    flags.set(key, value);
    i++;
  }
  const need = (key: string): string => {
    const v = flags.get(key);
    if (!v) throw new Error(`--${key} is required`);
    return v;
  };
  return {
    report1h: need('report-1h'),
    report4h: need('report-4h'),
    floor1h: need('floor-1h'),
    floor4h: need('floor-4h'),
    out: flags.get('out'),
  };
}

async function readReport(path: string): Promise<FactorIcReport> {
  const validated = validateFactorIcReport(JSON.parse(await readFile(path, 'utf8')));
  if (!validated.ok) throw new Error(`${path} failed schema validation:\n${validated.issues.join('\n')}`);
  return validated.data;
}

async function readFloor(path: string): Promise<NullReport> {
  return JSON.parse(await readFile(path, 'utf8')) as NullReport;
}

async function main(): Promise<void> {
  const args = parseVerdictArgs(process.argv.slice(2));
  const verdict = computeVerdict({
    reports: { '1h': await readReport(args.report1h), '4h': await readReport(args.report4h) },
    floors: { '1h': await readFloor(args.floor1h), '4h': await readFloor(args.floor4h) },
  });
  const text = JSON.stringify(verdict, null, 2) + '\n';
  if (args.out) {
    await writeFile(args.out, text, 'utf8');
    console.error(`[qh-flow-verdict] wrote ${args.out}`);
  }
  console.log(text);
  console.error(`[qh-flow-verdict] ${verdict.verdict}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
