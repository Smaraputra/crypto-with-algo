/**
 * Schemas the orchestrator validates every factor-IC study and subagent
 * report against, plus the one fixed survivor rule and the grounding/spot
 * check helpers it uses to catch a careless research agent.
 *
 * No I/O here: everything takes plain objects in and returns plain objects,
 * so it is usable from the CLI, from tests, and from the orchestrator's own
 * process without any of them sharing state.
 */

import { z } from 'zod';

import { benjaminiHochberg, pValueFromT } from './ic-stats';

export const HorizonStatSchema = z.object({
  horizon: z.number(),
  n: z.number(),
  ic: z.number(),
  icT: z.number(),
  nNonOverlapping: z.number(),
  icNonOverlapping: z.number(),
  signHitRate: z.number(),
  bootstrapCi95: z.tuple([z.number(), z.number()]).nullable(),
  quantileSpread: z.object({
    top: z.number(),
    bottom: z.number(),
    spread: z.number(),
  }),
});
export type HorizonStat = z.infer<typeof HorizonStatSchema>;

const RollingQuarterlyEntrySchema = z.object({
  quarter: z.string(),
  horizon: z.number(),
  ic: z.number(),
  n: z.number(),
  t: z.number(),
});
export type RollingQuarterlyEntry = z.infer<typeof RollingQuarterlyEntrySchema>;

export const FactorReportSchema = z.object({
  name: z.string(),
  category: z.string(),
  perSymbol: z.array(
    z.object({
      symbol: z.string(),
      horizons: z.array(HorizonStatSchema),
    })
  ),
  pooled: z.object({
    horizons: z.array(HorizonStatSchema),
  }),
  rollingQuarterly: z.array(RollingQuarterlyEntrySchema),
  /** Present only on a --cross-sectional-demean run: one Spearman per bar across symbols, HAC t at lag h-1 over the bar series. */
  crossSectional: z
    .object({
      minCrossSection: z.number(),
      horizons: z.array(
        z.object({ horizon: z.number(), bars: z.number(), meanBarIc: z.number(), hacT: z.number() })
      ),
    })
    .optional(),
});
export type FactorReport = z.infer<typeof FactorReportSchema>;

export const FactorIcReportSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string(),
  datasetManifestHash: z.string(),
  lockboxApplied: z.boolean(),
  interval: z.string(),
  symbols: z.array(z.string()),
  horizons: z.array(z.number()),
  /**
   * Bars between the bar a factor is read on and the entry its forward return
   * is measured from. Optional so reports written before the option existed
   * still validate; absent means 0, the Phase 3 convention.
   */
  executionLagBars: z.number().int().min(0).optional(),
  /**
   * Written only when set, so a default run's report stays byte-identical to
   * earlier ones. When it is set, each factor's `pooled.horizons[h]` is the
   * PER-BAR (Fama-MacBeth) statistic -- one Spearman per bar across symbols,
   * the mean over bars, HAC t at lag h-1 -- and not the Spearman pooled over
   * pairs, which on per-bar-demeaned returns is not a cross-sectional reading
   * at all. `crossSectional` restates those same numbers as the explicit
   * record. See factor-ic.ts's header for the measurement that settled it.
   */
  crossSectionalDemean: z.boolean().optional(),
  minCrossSection: z.number().int().min(3).optional(),
  returnSeries: z.enum(['spot', 'perp']).optional(),
  dateRange: z.object({
    startMs: z.number(),
    endMs: z.number(),
  }),
  computedAt: z.string(),
  gitCommit: z.string(),
  bootstrap: z.object({
    iterations: z.number(),
    seed: z.number(),
    perSymbol: z.boolean(),
    // Pooled bootstrapCi95 is only computed for cells whose pooled HAC |icT|
    // clears this gate (a candidate for the survivor rule); other cells
    // carry a null bootstrapCi95 rather than paying for a wide interval on
    // a cell nobody will treat as a finding. maxPairs bounds the pooled
    // series size fed into the bootstrap itself (see factor-ic.ts's
    // subsampling for cells above that size).
    gateAbsT: z.number(),
    maxPairs: z.number(),
  }),
  factors: z.array(FactorReportSchema),
  skippedFactors: z.array(
    z.object({
      name: z.string(),
      category: z.string(),
      reason: z.string(),
    })
  ),
});
export type FactorIcReport = z.infer<typeof FactorIcReportSchema>;

export const SubagentReportSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string(),
  agentModel: z.string(),
  datasetManifestHash: z.string(),
  lockboxApplied: z.boolean(),
  scope: z.object({
    kind: z.enum(['interval', 'strategy']),
    value: z.string(),
  }),
  subjects: z.array(z.string()),
  reportFiles: z.array(z.string()),
  topFindings: z.array(
    z.object({
      claim: z.string(),
      metric: z.string(),
      value: z.number(),
      n: z.number(),
      factor: z.string().optional(),
      horizon: z.number().optional(),
      symbol: z.string().optional(),
      window: z.number().optional(),
    })
  ),
  caveats: z.array(z.string()),
  reproCommand: z.string(),
  gitCommit: z.string(),
  durationMs: z.number(),
});
export type SubagentReport = z.infer<typeof SubagentReportSchema>;
export type SubagentFinding = SubagentReport['topFindings'][number];

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; issues: string[] };

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export function validateFactorIcReport(json: unknown): ValidationResult<FactorIcReport> {
  const result = FactorIcReportSchema.safeParse(json);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, issues: formatIssues(result.error) };
}

export function validateSubagentReport(json: unknown): ValidationResult<SubagentReport> {
  const result = SubagentReportSchema.safeParse(json);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, issues: formatIssues(result.error) };
}

/**
 * One fixed rule, applied the same way to every interval's report. A horizon
 * "passes" on its own merits (effect size and significance); quarter and
 * symbol agreement then test whether that effect is consistent over time and
 * across the study's symbols, rather than a fluke concentrated in one
 * quarter or one symbol.
 *
 * minT is 3.15 since 2026-09-26, the value the 2026-09-25 pre-registration
 * fixed (factors.ts header): |t| > 2.5 fires on 4.0% to 4.5% of zero-edge
 * trials for a persistent factor against a nominal 1.24%, and re-counting the
 * recorded p3b lag-1 reports at 3.15 loses nothing (5m 22, 15m 20, 1h 15,
 * 4h 7, 1d 4). The Benjamini-Hochberg control at 0.10 lives beside it in
 * evaluatePhaseSurvivors, because it is a property of a phase's cell set,
 * not of one report.
 */
export const SURVIVOR_RULE = {
  minAbsIc: 0.02,
  minT: 3.15,
  minHorizons: 2,
  minQuarterAgreement: 0.6,
  minSymbolAgreement: 0.7,
} as const;

export const PHASE_FDR_Q = 0.1;

export interface SurvivorRow {
  interval: string;
  /** The taskId of the report this row came from: what tells two rows on one interval apart. */
  taskId: string;
  factor: string;
  category: string;
  sign: 1 | -1 | 0;
  horizonsPassing: number[];
  quarterAgreement: number;
  symbolAgreement: number;
  survivor: boolean;
  reasons: string[];
  /** Horizons that cleared |ic| and |t| but not the phase FDR; absent when no FDR predicate was applied. */
  fdrExcludedHorizons?: number[];
}

function signOf(value: number): 1 | -1 | 0 {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

export type FdrPass = (factorName: string, horizon: number) => boolean;

function evaluateFactorSurvivor(
  interval: string,
  taskId: string,
  factor: FactorReport,
  fdrPass?: FdrPass
): SurvivorRow {
  const clearsThresholds = factor.pooled.horizons.filter(
    (h) => Math.abs(h.ic) >= SURVIVOR_RULE.minAbsIc && Math.abs(h.icT) >= SURVIVOR_RULE.minT
  );
  const passing = fdrPass ? clearsThresholds.filter((h) => fdrPass(factor.name, h.horizon)) : clearsThresholds;
  const fdrExcludedHorizons = fdrPass
    ? clearsThresholds
        .filter((h) => !fdrPass(factor.name, h.horizon))
        .map((h) => h.horizon)
        .sort((a, b) => a - b)
    : undefined;
  const horizonsPassing = passing.map((h) => h.horizon).sort((a, b) => a - b);
  const passingSet = new Set(horizonsPassing);

  // Sign is taken from the passing horizon with the strongest evidence (largest |icT|).
  let sign: 1 | -1 | 0 = 0;
  if (passing.length > 0) {
    const strongest = passing.reduce((best, h) => (Math.abs(h.icT) > Math.abs(best.icT) ? h : best));
    sign = signOf(strongest.ic);
  }

  const relevantQuarters = factor.rollingQuarterly.filter((r) => passingSet.has(r.horizon));
  const quarterAgreement =
    relevantQuarters.length === 0
      ? 0
      : relevantQuarters.filter((r) => signOf(r.ic) === sign).length / relevantQuarters.length;

  let agreeingSymbols = 0;
  for (const symbolEntry of factor.perSymbol) {
    const atPassingHorizons = symbolEntry.horizons.filter((h) => passingSet.has(h.horizon));
    const agreeing = atPassingHorizons.filter((h) => signOf(h.ic) === sign).length;
    // Strict majority (> half) of that symbol's passing-horizon readings share the sign.
    if (atPassingHorizons.length > 0 && agreeing * 2 > atPassingHorizons.length) {
      agreeingSymbols++;
    }
  }
  const symbolAgreement = factor.perSymbol.length === 0 ? 0 : agreeingSymbols / factor.perSymbol.length;

  const reasons: string[] = [];
  if (horizonsPassing.length < SURVIVOR_RULE.minHorizons) {
    reasons.push(
      `only ${horizonsPassing.length} horizon(s) passed the |ic|/|t| thresholds, need at least ${SURVIVOR_RULE.minHorizons}`
    );
  }
  if (quarterAgreement < SURVIVOR_RULE.minQuarterAgreement) {
    reasons.push(
      `quarter agreement ${quarterAgreement.toFixed(2)} is below the ${SURVIVOR_RULE.minQuarterAgreement} minimum`
    );
  }
  if (symbolAgreement < SURVIVOR_RULE.minSymbolAgreement) {
    reasons.push(
      `symbol agreement ${symbolAgreement.toFixed(2)} is below the ${SURVIVOR_RULE.minSymbolAgreement} minimum`
    );
  }

  return {
    interval,
    taskId,
    factor: factor.name,
    category: factor.category,
    sign,
    horizonsPassing,
    quarterAgreement,
    symbolAgreement,
    survivor: reasons.length === 0,
    reasons,
    ...(fdrExcludedHorizons !== undefined ? { fdrExcludedHorizons } : {}),
  };
}

export function evaluateSurvivors(report: FactorIcReport, fdrPass?: FdrPass): SurvivorRow[] {
  return report.factors.map((factor) =>
    evaluateFactorSurvivor(report.interval, report.taskId, factor, fdrPass)
  );
}

export interface PhaseSurvivorTable {
  minAbsIc: number;
  minT: number;
  fdrQ: number;
  /** Pooled (factor, horizon) cells across every report, the FDR's m. */
  cells: number;
  rejectedCells: number;
  perInterval: Array<{ interval: string; taskId: string; survivors: number; factors: number }>;
  rows: SurvivorRow[];
}

/**
 * The survivor rule applied across a whole phase: every pooled cell of every
 * report is one hypothesis, p from its HAC t, Benjamini-Hochberg at fdrQ, and
 * a horizon passes only if the FDR also rejects it. Cells are keyed by taskId
 * so two reports on one interval (say, time-series and cross-sectional) never
 * collide, which is why two reports sharing a taskId are a hard error rather
 * than a phase that silently merges their cells and gives each report the
 * other's FDR verdicts.
 */
export function evaluatePhaseSurvivors(reports: FactorIcReport[], fdrQ: number): PhaseSurvivorTable {
  const seenTaskIds = new Set<string>();
  for (const report of reports) {
    if (seenTaskIds.has(report.taskId)) {
      throw new Error(
        `evaluatePhaseSurvivors: duplicate taskId "${report.taskId}"; each report needs its own task id`
      );
    }
    seenTaskIds.add(report.taskId);
  }

  const cells: Array<{ key: string; p: number }> = [];
  for (const report of reports) {
    for (const factor of report.factors) {
      for (const h of factor.pooled.horizons) {
        cells.push({ key: `${report.taskId}|${factor.name}|${h.horizon}`, p: pValueFromT(h.icT) });
      }
    }
  }
  const rejected = benjaminiHochberg(
    cells.map((c) => c.p),
    fdrQ
  );
  const passSet = new Set(cells.filter((_, i) => rejected[i]).map((c) => c.key));

  const rows: SurvivorRow[] = [];
  const perInterval: PhaseSurvivorTable['perInterval'] = [];
  for (const report of reports) {
    const fdrPass: FdrPass = (name, horizon) => passSet.has(`${report.taskId}|${name}|${horizon}`);
    const reportRows = evaluateSurvivors(report, fdrPass);
    rows.push(...reportRows);
    perInterval.push({
      interval: report.interval,
      taskId: report.taskId,
      survivors: reportRows.filter((r) => r.survivor).length,
      factors: report.factors.length,
    });
  }
  return {
    minAbsIc: SURVIVOR_RULE.minAbsIc,
    minT: SURVIVOR_RULE.minT,
    fdrQ,
    cells: cells.length,
    rejectedCells: passSet.size,
    perInterval,
    rows,
  };
}

// horizon and n are deliberately excluded: a claim's value must match a
// statistic, not an index (horizon) or a sample size (n) -- a finding whose
// value happens to equal the horizon number or the pair count is not
// grounded by that coincidence.
function horizonStatNumbers(stat: HorizonStat): number[] {
  const numbers = [
    stat.ic,
    stat.icT,
    stat.icNonOverlapping,
    stat.signHitRate,
    stat.quantileSpread.top,
    stat.quantileSpread.bottom,
    stat.quantileSpread.spread,
  ];
  if (stat.bootstrapCi95) numbers.push(stat.bootstrapCi95[0], stat.bootstrapCi95[1]);
  return numbers;
}

function rollingEntryNumbers(entry: RollingQuarterlyEntry): number[] {
  return [entry.ic, entry.t];
}

function valueMatchesAny(value: number, candidates: number[]): boolean {
  return candidates.some((candidate) => Math.abs(candidate - value) <= 1e-9);
}

/**
 * Every headline finding must cite a number that exists in the study's own
 * tables. A finding grounds against the named factor's pooled table (plus
 * its rolling-quarterly entries) when no symbol is given, or that symbol's
 * own table when one is. `metric` only describes the claim for a human
 * reader; grounding checks the value against every numeric field of the
 * matching HorizonStat/rolling entries, not just the one `metric` names --
 * except `horizon` and `n`, which are excluded (an index and a sample size,
 * not a statistic a finding should be able to "cite").
 */
export function checkFindings(
  sub: SubagentReport,
  factorReport: FactorIcReport
): Array<{ index: number; reason: string }> {
  const ungrounded: Array<{ index: number; reason: string }> = [];

  sub.topFindings.forEach((finding, index) => {
    if (finding.factor === undefined) {
      ungrounded.push({ index, reason: 'finding has no factor to ground against' });
      return;
    }

    const factor = factorReport.factors.find((f) => f.name === finding.factor);
    if (!factor) {
      ungrounded.push({ index, reason: `factor "${finding.factor}" not found in report` });
      return;
    }

    const candidates: number[] = [];

    if (finding.symbol !== undefined) {
      const symbolEntry = factor.perSymbol.find((p) => p.symbol === finding.symbol);
      const horizons = symbolEntry
        ? finding.horizon !== undefined
          ? symbolEntry.horizons.filter((h) => h.horizon === finding.horizon)
          : symbolEntry.horizons
        : [];
      for (const h of horizons) candidates.push(...horizonStatNumbers(h));
    } else {
      const horizons =
        finding.horizon !== undefined
          ? factor.pooled.horizons.filter((h) => h.horizon === finding.horizon)
          : factor.pooled.horizons;
      for (const h of horizons) candidates.push(...horizonStatNumbers(h));

      const rolling =
        finding.horizon !== undefined
          ? factor.rollingQuarterly.filter((r) => r.horizon === finding.horizon)
          : factor.rollingQuarterly;
      for (const r of rolling) candidates.push(...rollingEntryNumbers(r));
    }

    if (!valueMatchesAny(finding.value, candidates)) {
      const scope =
        finding.symbol !== undefined ? `symbol ${finding.symbol}` : 'pooled';
      const horizonPart = finding.horizon !== undefined ? ` horizon ${finding.horizon}` : '';
      ungrounded.push({
        index,
        reason: `value ${finding.value} not found for factor "${finding.factor}"${horizonPart} (${scope})`,
      });
    }
  });

  return ungrounded;
}

/**
 * Compares a freshly recomputed cell (ic, n) against the report's own value
 * for that factor/horizon[/symbol], to catch a careless agent that fabricated
 * or mis-transcribed a number. Tolerant of small floating-point drift between
 * runs (deltaIc), but requires n to match exactly -- a different sample size
 * means a different dataset window or a different pairing, not just noise.
 */
export function spotCheckCell(
  report: FactorIcReport,
  cell: { factor: string; horizon: number; symbol?: string },
  recomputed: { ic: number; n: number }
): { ok: boolean; deltaIc: number; nMatches: boolean } {
  const factor = report.factors.find((f) => f.name === cell.factor);
  const horizons = cell.symbol
    ? factor?.perSymbol.find((p) => p.symbol === cell.symbol)?.horizons
    : factor?.pooled.horizons;
  const stat = horizons?.find((h) => h.horizon === cell.horizon);

  if (!stat) {
    return { ok: false, deltaIc: NaN, nMatches: false };
  }

  const deltaIc = recomputed.ic - stat.ic;
  const nMatches = recomputed.n === stat.n;
  const ok = Math.abs(deltaIc) <= 0.01 && nMatches;
  return { ok, deltaIc, nMatches };
}

/**
 * Nothing else pins which dataset a subagent's report actually studied.
 * Fails when the subagent report and the factor report it cites disagree on
 * datasetManifestHash (a different, or since-changed, dataset) or
 * lockboxApplied (a different held-out window) -- either means the
 * subagent's headline claims cannot be trusted to describe this factor
 * report's own numbers, whatever checkFindings/spotCheckCell say about the
 * numbers themselves.
 */
export function checkReportConsistency(
  sub: SubagentReport,
  factorReport: FactorIcReport
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];

  if (sub.datasetManifestHash !== factorReport.datasetManifestHash) {
    issues.push(
      `datasetManifestHash mismatch: subagent report has "${sub.datasetManifestHash}", factor report has "${factorReport.datasetManifestHash}"`
    );
  }
  if (sub.lockboxApplied !== factorReport.lockboxApplied) {
    issues.push(
      `lockboxApplied mismatch: subagent report has ${sub.lockboxApplied}, factor report has ${factorReport.lockboxApplied}`
    );
  }

  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Strategy report: the walk-forward validation protocol's report, written by
// scripts/research/strategy-harness.ts and read by the orchestrator. The
// `pooled` and `gates` shapes mirror scripts/research/strategy-gates.ts's
// PooledStats/Gate interfaces field for field -- that module computes them
// with no Zod dependency (pure, no I/O), this schema only validates the
// already-computed values once they reach a report.
// ---------------------------------------------------------------------------

const WindowModeSchema = z.enum(['rolling', 'anchored']);

const GridParamsSchema = z.record(z.string(), z.number());

const GateNameSchema = z.enum([
  'sample',
  'expectancy',
  'windows',
  'symbols',
  'timing',
  'trials',
  'plateau',
  'stress',
]);

const GateSchema = z.object({
  name: GateNameSchema,
  pass: z.boolean(),
  value: z.number().nullable(),
  threshold: z.number(),
  note: z.string().optional(),
});
export type StrategyGate = z.infer<typeof GateSchema>;

const PooledStatsSchema = z.object({
  n: z.number(),
  expectancyPercent: z.number().nullable(),
  expectancyR: z.number().nullable(),
  winRate: z.number().nullable(),
  profitFactor: z.number().nullable(),
  // Reported only, no gate reads them. Zod strips unknown keys, so a field
  // added to PooledStats without a matching entry here vanishes on parse.
  // Optional so reports written before 2026-09-19 still validate.
  avgWinPercent: z.number().nullable().optional(),
  avgLossPercent: z.number().nullable().optional(),
  payoffRatio: z.number().nullable().optional(),
  // Raw per-trade sd, added 2026-10-01 (review M6). Optional so every earlier
  // report still validates; frontier.ts recovers it for those reports.
  sdPercent: z.number().nullable().optional(),
  medianHoldBars: z.number().nullable(),
  maxDrawdownPercent: z.number().nullable(),
  bootstrapCi95: z.tuple([z.number(), z.number()]).nullable(),
  bootstrap: z.object({
    iterations: z.number(),
    seed: z.number(),
    meanBlockLen: z.number(),
  }),
  windowsTotal: z.number(),
  windowsPositive: z.number(),
  windowPositiveShare: z.number(),
  symbolsTotal: z.number(),
  symbolsPositive: z.number(),
  symbolPositiveShare: z.number(),
  // Reported only, never a gate. Optional so reports written before
  // 2026-09-26 (every p4, p4c and p5 file) still validate.
  oosSymbolDays: z.number().nullable().optional(),
  tradesPerSymbolDay: z.number().nullable().optional(),
  tradesPerDay: z.number().nullable().optional(),
  benchmarkWindows: z.number(),
  randomEntryP: z.number().nullable(),
  trials: z.number(),
  deflatedSharpe: z
    .object({
      observedSharpe: z.number(),
      benchmarkSharpe: z.number(),
      probability: z.number().nullable(),
      radicand: z.number(),
      varianceOfTrialSharpes: z.number(),
    })
    .nullable(),
  plateau: z
    .object({
      score: z.number().nullable(),
      neighbors: z.number(),
      bestMetric: z.number(),
      bestParams: GridParamsSchema,
      neighborRadius: z.number(),
    })
    .nullable(),
  stressTrades: z.number(),
  stressExpectancyPercent: z.number().nullable(),
  perYear: z.array(
    z.object({
      year: z.number(),
      trades: z.number(),
      expectancyPercent: z.number(),
    })
  ),
});
export type StrategyPooledStats = z.infer<typeof PooledStatsSchema>;

const StrategyCellSummarySchema = z.object({
  params: GridParamsSchema,
  trades: z.number(),
  expectancyPercent: z.number().nullable(),
  expectancyR: z.number().nullable(),
  perTradeSharpe: z.number().nullable(),
  winRate: z.number().nullable(),
  profitFactor: z.number().nullable(),
  maxDrawdownPercent: z.number().nullable(),
});

const StrategyOosCellSchema = z.object({
  params: GridParamsSchema,
  trades: z.number(),
  expectancyPercent: z.number().nullable(),
});

/** One out-of-sample trade, written only by fixed-evaluation runs (the legends phase's daily series reads it). */
const StrategyWindowTradeSchema = z.object({
  entryTime: z.number(),
  exitTime: z.number(),
  side: z.enum(['long', 'short']),
  pnlPercent: z.number(),
  exitReason: z.string(),
  holdTimeBars: z.number(),
});

const StrategyWindowSchema = z.object({
  /** Fixed-evaluation runs only. */
  trades: z.array(StrategyWindowTradeSchema).optional(),
  index: z.number(),
  trainStart: z.number(),
  trainEnd: z.number(),
  testStart: z.number(),
  testEnd: z.number(),
  selectedParams: GridParamsSchema.nullable(),
  skippedReason: z.string().nullable(),
  isCells: z.array(StrategyCellSummarySchema),
  oosCells: z.array(StrategyOosCellSchema),
  oos: z
    .object({
      trades: z.number(),
      expectancyPercent: z.number().nullable(),
      expectancyR: z.number().nullable(),
      winRate: z.number().nullable(),
      profitFactor: z.number().nullable(),
      maxDrawdownPercent: z.number().nullable(),
      medianHoldBars: z.number().nullable(),
      fees: z.number(),
      slippageCost: z.number(),
      fundingCost: z.number(),
      snapshotCoveragePercent: z.number().nullable(),
    })
    .nullable(),
  stress: z
    .object({
      trades: z.number(),
      expectancyPercent: z.number().nullable(),
    })
    .nullable(),
  benchmark: z
    .object({
      iterations: z.number(),
      seed: z.number(),
      meanRandom: z.number(),
      sdRandom: z.number(),
      pValue: z.number().nullable(),
      referenceTrades: z.number(),
    })
    .nullable(),
});

const StrategyResolvedWindowConfigSchema = z.object({
  trainBars: z.number(),
  testWindowBars: z.number(),
  purgeGapBars: z.number(),
  stepSizeBars: z.number(),
  mode: WindowModeSchema,
  count: z.number(),
});

const StrategyPerSymbolSchema = z.object({
  symbol: z.string(),
  snapshotRows: z.number(),
  htfBars: z.number(),
  windowConfig: StrategyResolvedWindowConfigSchema,
  /** The seed this symbol's random-entry benchmark used (base seed + this
   * symbol's index * 1,000,000, so correlated symbols never draw the same
   * mulberry32 stream on the same timestamps); null when the benchmark was
   * disabled (--no-benchmark). */
  benchmarkSeed: z.number().nullable(),
  windows: z.array(StrategyWindowSchema),
  pooledOos: z.object({
    trades: z.number(),
    expectancyPercent: z.number().nullable(),
    winRate: z.number().nullable(),
  }),
  // Optional so reports written before 2026-09-26 (the fee-profile flag)
  // still validate; present when this symbol's costs were resolved from a
  // fee profile (studyCostConfig's per-symbol resolution).
  costs: z
    .object({
      feePercent: z.number(),
      makerFeePercent: z.number(),
      takerFeePercent: z.number(),
      slippageBps: z.number(),
    })
    .optional(),
});

const FixedEvaluationSchema = z.object({
  startAtListing: z.boolean(),
  evalFrom: z.number().nullable(),
  fundingSource: z.enum(['settlements', 'snapshots']),
  price: z.enum(['spot', 'perp']),
  perpFrom: z.number().nullable(),
  perSymbol: z.record(
    z.string(),
    z.object({
      listingDay: z.number().nullable(),
      evalStartTime: z.number(),
      warmupBars: z.number(),
      perpFilledBars: z.number(),
      fallbackSettlements: z.number(),
      stopEntries: z.object({ placed: z.number(), filled: z.number(), ambiguous: z.number(), expired: z.number() }),
      stopExitsReachingTarget: z.number(),
      targetFirst: z.object({ trades: z.number(), expectancyPercent: z.number() }),
    })
  ),
});

export const StrategyReportSchema = z.object({
  /** Legends phase fixed-evaluation runs only (strategy-harness.ts --fixed-eval). */
  fixedEvaluation: FixedEvaluationSchema.optional(),
  schemaVersion: z.literal(1),
  taskId: z.string(),
  datasetManifestHash: z.string(),
  lockboxApplied: z.boolean(),
  family: z.string(),
  style: z.string(),
  interval: z.string(),
  symbols: z.array(z.string()),
  dateRange: z.object({
    startMs: z.number().nullable(),
    endMs: z.number().nullable(),
  }),
  gridCells: z.number(),
  trials: z.number(),
  snapshotSource: z.string().nullable(),
  // Optional so reports written before 2026-09-26 (the fee-profile flag)
  // still validate.
  feeProfile: z.string().optional(),
  costs: z.object({
    feePercent: z.number(),
    makerFeePercent: z.number(),
    takerFeePercent: z.number(),
    slippageBps: z.number(),
    fundingEnabled: z.boolean(),
  }),
  windowConfig: z.object({
    mode: WindowModeSchema,
    trainFraction: z.number(),
    count: z.number(),
    minIsTrades: z.number(),
  }),
  stress: z.object({
    feeMultiplier: z.number(),
    slippageMultiplier: z.number(),
  }),
  benchmark: z.object({
    enabled: z.boolean(),
    iterations: z.number(),
    seed: z.number(),
  }),
  bootstrap: z.object({
    iterations: z.number(),
    seed: z.number(),
    meanBlockLen: z.number(),
  }),
  perSymbol: z.array(StrategyPerSymbolSchema),
  pooled: PooledStatsSchema,
  gates: z.array(GateSchema),
  pass: z.boolean(),
  computedAt: z.string(),
  gitCommit: z.string(),
  durationMs: z.number(),
  // Optional so reports written before --fix-params/--allowed-sessions
  // (2026-09-28) still validate. fixedParams is the single grid cell
  // --fix-params collapsed expandGrid's output to, recorded so --cell
  // --report can read it back rather than re-deriving it; allowedSessions
  // is the session gate every window, the random-entry benchmark, and the
  // stress re-run all ran under (see strategy-walk-forward.ts).
  fixedParams: GridParamsSchema.optional(),
  allowedSessions: z.array(z.string()).optional(),
});
export type StrategyReport = z.infer<typeof StrategyReportSchema>;

export function validateStrategyReport(json: unknown): ValidationResult<StrategyReport> {
  const result = StrategyReportSchema.safeParse(json);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, issues: formatIssues(result.error) };
}

/**
 * The banded-exposure path's report, deliberately a SEPARATE schema rather
 * than an extension of StrategyReportSchema.
 *
 * Two reasons. The two report types share almost no fields -- a discrete run
 * reports trades, a win rate and a payoff ratio, and an exposure run reports
 * bars held, a Sharpe and a turnover -- so extending would be two disjoint
 * halves in one object and every reader would have to know which half applied.
 * And Zod's plain `z.object` STRIPS unknown keys silently rather than
 * erroring, which has already cost this program once: `payoffRatio` was
 * computed into `PooledStats` with no matching schema entry and would have
 * vanished on parse with no error at all. Keeping the schemas apart means a
 * field added to one path's stats cannot be silently swallowed by the other's
 * schema.
 */
const ExposureGateSchema = z.object({
  name: z.enum([
    'sample',
    'expectancy',
    'windows',
    'symbols',
    'timing',
    'trials',
    'stress',
    'plateau',
  ]),
  pass: z.boolean(),
  value: z.number().nullable(),
  threshold: z.number(),
  note: z.string().optional(),
});

const ExposurePooledStatsSchema = z.object({
  barsHeld: z.number(),
  barsTotal: z.number(),
  exposureShare: z.number(),
  // Optional so reports written before the rank-book fields (2026-09-27)
  // still validate.
  meanAbsNetExposure: z.number().optional(),
  meanReturnPercent: z.number().nullable(),
  longLegMeanReturnPercent: z.number().nullable().optional(),
  shortLegMeanReturnPercent: z.number().nullable().optional(),
  sharpe: z.number().nullable(),
  sharpeCi95: z.tuple([z.number(), z.number()]).nullable(),
  maxDrawdownPercent: z.number().nullable(),
  bootstrap: z.object({
    iterations: z.number(),
    seed: z.number(),
    meanBlockLen: z.number(),
  }),
  windowsTotal: z.number(),
  windowsPositive: z.number(),
  windowPositiveShare: z.number(),
  symbolsTotal: z.number(),
  symbolsPositive: z.number(),
  symbolPositiveShare: z.number(),
  jackknifeTotal: z.number(),
  jackknifePositive: z.number(),
  jackknifeWorstMeanReturnPercent: z.number().nullable(),
  jackknifeWithoutBtcMeanReturnPercent: z.number().nullable().optional(),
  timingDraws: z.number(),
  timingP: z.number().nullable(),
  trials: z.number(),
  deflatedSharpe: z
    .object({
      observedSharpe: z.number(),
      benchmarkSharpe: z.number(),
      probability: z.number().nullable(),
      radicand: z.number(),
      varianceOfTrialSharpes: z.number(),
    })
    .nullable(),
  plateau: z
    .object({
      score: z.number().nullable(),
      neighbors: z.number(),
      bestMetric: z.number(),
      bestParams: GridParamsSchema,
      neighborRadius: z.number(),
    })
    .nullable(),
  stressMeanReturnPercent: z.number().nullable(),
  totalTurnover: z.number(),
  meanBarsBetweenRebalances: z.number().nullable(),
});

const ExposurePerSymbolSchema = z.object({
  symbol: z.string(),
  bars: z.number(),
  meanContributionPercent: z.number().nullable(),
  positive: z.boolean(),
  // Optional so reports written before the spot-grid intersection fix
  // (2026-09-28) still validate. Perp bars dropped because the spot file
  // exists but does not carry that timestamp; absent (not zero) when nothing
  // was dropped.
  perpBarsOffSpotGrid: z.number().optional(),
});

const ExposureWindowSchema = z.object({
  window: z.number(),
  params: GridParamsSchema,
  bars: z.number(),
  positive: z.boolean(),
  sharpe: z.number().nullable(),
  meanReturnPercent: z.number().nullable(),
});

export const ExposureReportSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string(),
  datasetManifestHash: z.string(),
  lockboxApplied: z.boolean(),
  /** The factor column this run held, e.g. positioningZ360. */
  factor: z.string(),
  interval: z.string(),
  symbols: z.array(z.string()),
  dateRange: z.object({
    startMs: z.number().nullable(),
    endMs: z.number().nullable(),
  }),
  gridCells: z.number(),
  trials: z.number(),
  // Optional so reports written before 2026-09-26 (the fee-profile flag)
  // still validate.
  feeProfile: z.string().optional(),
  // Optional so reports written before the rank-book container (2026-09-27)
  // still validate. 'mode' distinguishes a tanh run from a rank run;
  // 'factorSign', 'minCrossSection', 'fill' and 'excludedSymbols' mirror the
  // simulator options a rank run carries, and 'selectMetric' names the grid
  // selection metric.
  mode: z.enum(['exposure', 'rank']).optional(),
  factorSign: z.union([z.literal(1), z.literal(-1)]).optional(),
  minCrossSection: z.number().int().min(2).optional(),
  selectMetric: z.enum(['sharpe', 'meanReturn']).optional(),
  fill: z.enum(['taker', 'maker']).optional(),
  excludedSymbols: z.array(z.string()).optional(),
  costs: z.object({
    feePercent: z.number(),
    slippageBps: z.number(),
  }),
  windowConfig: z.object({
    mode: WindowModeSchema,
    trainFraction: z.number(),
    count: z.number(),
    minIsSharpeBars: z.number(),
  }),
  stress: z.object({
    feeMultiplier: z.number(),
    slippageMultiplier: z.number(),
  }),
  bootstrap: z.object({
    iterations: z.number(),
    seed: z.number(),
    meanBlockLen: z.number(),
  }),
  timing: z.object({
    draws: z.number(),
    /** The realised block length the shuffle used. */
    blockLength: z.number(),
  }),
  perSymbol: z.array(ExposurePerSymbolSchema),
  windows: z.array(ExposureWindowSchema),
  pooled: ExposurePooledStatsSchema,
  gates: z.array(ExposureGateSchema),
  pass: z.boolean(),
  computedAt: z.string(),
  gitCommit: z.string(),
  durationMs: z.number(),
});
export type ExposureReport = z.infer<typeof ExposureReportSchema>;

export function validateExposureReport(json: unknown): ValidationResult<ExposureReport> {
  const result = ExposureReportSchema.safeParse(json);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, issues: formatIssues(result.error) };
}

/**
 * The funding carry report (scripts/research/carry-harness.ts). Its own
 * schema rather than a widened exposure one: a carry book has two legs,
 * settlements, capital and leverage, none of which the exposure report
 * carries. Every field is declared, because Zod strips what is not.
 */
const AnnualStatSchema = z.object({
  annual: z.number().nullable(),
  ciLow: z.number().nullable(),
  ciHigh: z.number().nullable(),
  days: z.number(),
});

const CarryGateSchema = z.object({
  name: z.enum(['significance', 'hurdle', 'periods']),
  pass: z.boolean(),
  value: z.number().nullable(),
  threshold: z.number(),
  note: z.string(),
});

const CarryRuleResultSchema = z.object({
  rule: z.string(),
  stat: AnnualStatSchema,
  /** Block-length sensitivity: the same statistic at 10 and 40 day blocks. */
  statBlock10: AnnualStatSchema,
  statBlock40: AnnualStatSchema,
  periods: z.array(z.object({ label: z.string(), annual: z.number().nullable(), days: z.number() })),
  gates: z.array(CarryGateSchema),
  killed: z.boolean(),
  fundingAnnual: z.number().nullable(),
  costAnnual: z.number().nullable(),
  perSymbolAnnual: z.record(z.string(), z.number().nullable()),
  jackknifeAnnual: z.record(z.string(), z.number().nullable()),
  costRows: z.array(z.object({ profile: z.string(), annual: z.number().nullable() })),
  leverage: z.array(
    z.object({
      leverage: z.number(),
      liquidationDistance: z.number(),
      annualOnCapital: z.number().nullable(),
      liquidations: z.number(),
      liquidationCostAnnual: z.number().nullable(),
      worstAdverseMove: z.number(),
      worstDrawdownOnCapital: z.number(),
    })
  ),
});

export const CarryReportSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string(),
  datasetManifestHash: z.string(),
  lockboxApplied: z.boolean(),
  symbols: z.array(z.string()),
  trials: z.number(),
  costPerSide: z.number(),
  meanBlockLenDays: z.number(),
  windows: z.array(
    z.object({
      testFrom: z.number(),
      testTo: z.number(),
      trainFrom: z.number(),
      trainTo: z.number(),
      r1Selected: z.string(),
      r1TrainAnnual: z.number().nullable(),
      r0Annual: z.number().nullable(),
      r1Annual: z.number().nullable(),
    })
  ),
  r0: CarryRuleResultSchema,
  r1: CarryRuleResultSchema,
  r1VsR0: AnnualStatSchema,
  timing: z.object({ p: z.number(), observed: z.number().nullable(), nullMean: z.number().nullable(), draws: z.number() }),
  r1IsTimingFinding: z.boolean(),
  feasibility: z.array(
    z.object({
      symbol: z.string(),
      capital: z.number(),
      notionalSingle: z.number(),
      feasibleSingle: z.boolean(),
      notionalInBook: z.number(),
      feasibleInBook: z.boolean(),
    })
  ),
  killCriterionFires: z.boolean(),
  computedAt: z.string(),
  gitCommit: z.string(),
  durationMs: z.number(),
});
export type CarryReport = z.infer<typeof CarryReportSchema>;

export function validateCarryReport(json: unknown): ValidationResult<CarryReport> {
  const result = CarryReportSchema.safeParse(json);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, issues: formatIssues(result.error) };
}

/**
 * The legends phase trend report (scripts/research/trend-harness.ts), one per
 * pre-registered exposure rule (TF1 to TF4, C3). It carries the PRIMARY daily
 * return series so the phase-level deflated Sharpe (gate 8) can be computed
 * once across all eleven trials. Every field is declared, because Zod strips
 * what is not.
 */
const TrendCiSchema = z.object({
  point: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
  blockLen: z.number(),
});

const TrendRunSummarySchema = z.object({
  days: z.number(),
  sharpe: z.number().nullable(),
  annualReturn: z.number().nullable(),
  longLegAnnual: z.number().nullable(),
  shortLegAnnual: z.number().nullable(),
  costAnnual: z.number().nullable(),
  fundingAnnual: z.number().nullable(),
  turnoverAnnual: z.number().nullable(),
  maxDrawdown: z.number(),
  gross: z.object({
    mean: z.number().nullable(),
    p50: z.number().nullable(),
    p95: z.number().nullable(),
    max: z.number().nullable(),
    shareAbove1: z.number().nullable(),
    shareAbove2: z.number().nullable(),
    shareAbove3: z.number().nullable(),
  }),
});

const TrendGateSchema = z.object({
  id: z.number(),
  name: z.enum(['sample', 'expectancy', 'twin', 'timing', 'symbols', 'years', 'stress', 'trials', 'consistency']),
  pass: z.boolean().nullable(),
  value: z.number().nullable(),
  threshold: z.number(),
  note: z.string(),
});

const TrendAlphaPointSchema = z.object({
  alpha: z.number().nullable(),
  beta: z.number().nullable(),
  sharpe: z.number().nullable(),
  twinSharpe: z.number().nullable(),
});

export const TrendReportSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string(),
  rule: z.enum(['TF1', 'TF2', 'TF3', 'TF4', 'C3']),
  datasetManifestHash: z.string(),
  lockboxApplied: z.boolean(),
  symbols: z.array(z.string()),
  cost: z.object({ fee: z.number(), slippage: z.number() }),
  sample: z.object({ from: z.number(), to: z.number(), firstDay: z.number(), lastDay: z.number(), days: z.number() }),
  startDays: z.record(z.string(), z.number()),
  fallbackSettlements: z.record(z.string(), z.number()),
  filledDays: z.record(z.string(), z.object({ primary: z.number(), perp: z.number() })),
  run: TrendRunSummarySchema,
  twin: TrendRunSummarySchema,
  sharpe: TrendCiSchema,
  sharpeBlock20: TrendCiSchema,
  sharpeBlock120: TrendCiSchema,
  sharpeDifference: z.number().nullable(),
  alpha: TrendCiSchema,
  alphaBlock20: TrendCiSchema,
  alphaBlock120: TrendCiSchema,
  beta: z.number().nullable(),
  timing: z.object({ p: z.number(), nullMean: z.number().nullable(), draws: z.number() }),
  dropOne: z.record(z.string(), z.number().nullable()),
  years: z.array(z.object({ year: z.number(), alpha: z.number().nullable(), days: z.number() })),
  stress: TrendAlphaPointSchema,
  delay1: TrendAlphaPointSchema,
  consistency: z.object({
    from: z.number(),
    days: z.number(),
    perp: TrendAlphaPointSchema,
    spot: TrendAlphaPointSchema,
    spotMinusPerpAlpha: z.number().nullable(),
  }),
  episodes: z.object({
    count: z.number(),
    topShare: z.number().nullable(),
    topSum: z.number(),
    total: z.number(),
    longestLosingStreak: z.number(),
    expectedLongestLosingStreak: z.number().nullable(),
    lossRate: z.number().nullable(),
  }),
  perSymbol: z.record(
    z.string(),
    z.object({
      sharpe: z.number().nullable(),
      annual: z.number().nullable(),
      twinSharpe: z.number().nullable(),
      twinAnnual: z.number().nullable(),
    })
  ),
  gates: z.array(TrendGateSchema),
  verdict: z.enum(['fail', 'pending-trials', 'pass']),
  daily: z.object({ days: z.array(z.number()), returns: z.array(z.number()) }),
  computedAt: z.string(),
  gitCommit: z.string(),
  durationMs: z.number(),
});
export type TrendReport = z.infer<typeof TrendReportSchema>;

export function validateTrendReport(json: unknown): ValidationResult<TrendReport> {
  const result = TrendReportSchema.safeParse(json);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, issues: formatIssues(result.error) };
}

/**
 * The broad trend phase report (scripts/research/broad-harness.ts), schema
 * version 2, one per pre-registered rule (broad-trend.ts header). A new schema:
 * TrendReportSchema above stays the legends phase's. It carries the nine gates
 * (gate 8 pending, settled by broad-dsr.ts across the five), every reported
 * statistic, the export and universe hashes, the parameters and the daily
 * return series gate 8 reads. Every field is declared, because Zod strips what
 * is not.
 */
const BroadGateSchema = z.object({
  id: z.number(),
  name: z.enum(['sample', 'expectancy', 'twin', 'timing', 'cohorts', 'years', 'stress', 'trials', 'ex2021']),
  pass: z.boolean().nullable(),
  value: z.number().nullable(),
  threshold: z.number(),
  note: z.string(),
});
export type BroadGate = z.infer<typeof BroadGateSchema>;

const BroadBenchmarkSchema = z.object({
  available: z.boolean(),
  note: z.string(),
  alpha: z.number().nullable(),
  beta: z.number().nullable(),
  benchmarkSharpe: z.number().nullable(),
  benchmarkAnnual: z.number().nullable(),
});

const BroadNullSchema = z.object({
  mode: z.enum(['wrapped', 'aligned']),
  /** Null when the observed alpha is undefined: the gate fails. */
  p: z.number().nullable(),
  nullMean: z.number().nullable(),
  draws: z.number(),
  /** Member-days shifted out of calendar alignment ('wrapped'); 0 by construction for 'aligned'. */
  misalignedShare: z.number().nullable(),
  /** 'aligned': member-days whose shifted source lies outside the contract's life (exposure lost). */
  outsideLifeShare: z.number().nullable(),
});

const BroadDropSchema = z.object({
  label: z.string(),
  contracts: z.array(z.string()),
  memberDays: z.number(),
  share: z.number().nullable(),
  alpha: z.number().nullable(),
  beta: z.number().nullable(),
});

export const BroadTrendReportSchema = z.object({
  schemaVersion: z.literal(2),
  phase: z.literal('broad-trend'),
  taskId: z.string(),
  rule: z.enum(['TF1', 'TF2', 'TF3', 'TF4', 'C3']),
  datasetManifestHash: z.string(),
  universe: z.object({
    sha256: z.string(),
    sourceDatasetHash: z.string(),
    startClose: z.string(),
    startLaterThan20210701: z.boolean(),
    contracts: z.number(),
    basketContracts: z.number(),
  }),
  lockboxApplied: z.boolean(),
  parameters: z.object({
    from: z.number(),
    to: z.number(),
    fee: z.number(),
    slippageTiers: z.array(z.object({ maxRank: z.number(), bps: z.number() })),
    leaveSlippage: z.number(),
    delistHaircut: z.number(),
    stress: z.object({
      feeMultiple: z.number(),
      slippageMultiple: z.number(),
      delistHaircut: z.number(),
      reportedHaircut: z.number(),
    }),
    blockDays: z.number(),
    blockSensitivity: z.array(z.number()),
    bootstrapDraws: z.number(),
    bootstrapSeed: z.number(),
    nullDraws: z.number(),
    nullSeed: z.number(),
    nullCalendarStart: z.number(),
    nullCalendarDays: z.number(),
    nullSizeUniverses: z.number(),
    nullSizeSeed: z.number(),
    nullSizeDraws: z.number(),
    minSampleDays: z.number(),
    timingP: z.number(),
    minPositiveYearShare: z.number(),
    gatedYears: z.array(z.number()),
    cohortMinShare: z.number(),
    ex2021From: z.number(),
    ex2021To: z.number(),
  }),
  sample: z.object({
    from: z.number(),
    to: z.number(),
    firstDefinedDay: z.number().nullable(),
    firstDay: z.number().nullable(),
    lastDay: z.number().nullable(),
    days: z.number(),
  }),
  run: TrendRunSummarySchema,
  twin: TrendRunSummarySchema,
  sharpe: TrendCiSchema,
  sharpeBlock20: TrendCiSchema,
  sharpeBlock120: TrendCiSchema,
  sharpeDifference: z.number().nullable(),
  alpha: TrendCiSchema,
  alphaBlock20: TrendCiSchema,
  alphaBlock120: TrendCiSchema,
  beta: z.number().nullable(),
  benchmarks: z.object({ btc: BroadBenchmarkSchema, memberBasket: BroadBenchmarkSchema }),
  timing: z.object({ wrapped: BroadNullSchema, aligned: BroadNullSchema, gatingP: z.number().nullable() }),
  nullSize: z
    .object({
      universes: z.number(),
      seed: z.number(),
      draws: z.number(),
      wrappedRejection: z.number().nullable(),
      alignedRejection: z.number().nullable(),
      bothRejection: z.number().nullable(),
      perUniverse: z.array(
        z.object({ observedAlpha: z.number().nullable(), wrappedP: z.number().nullable(), alignedP: z.number().nullable() })
      ),
    })
    .nullable(),
  cohorts: z.object({
    listingYears: z.array(BroadDropSchema.extend({ years: z.array(z.number()) })),
    legendsTen: BroadDropSchema,
    btcEth: BroadDropSchema,
    top5: BroadDropSchema.extend({
      contributions: z.array(z.object({ contract: z.string(), contribution: z.number() })),
    }),
  }),
  years: z.array(z.object({ year: z.number(), alpha: z.number().nullable(), beta: z.number().nullable(), days: z.number() })),
  stress: TrendAlphaPointSchema,
  stressHaircut5: TrendAlphaPointSchema,
  ex2021: z.object({
    from: z.number(),
    to: z.number(),
    days: z.number(),
    alpha: z.number().nullable(),
    beta: z.number().nullable(),
  }),
  delay1: TrendAlphaPointSchema,
  membersPerMonth: z.array(
    z.object({
      close: z.string(),
      eligible: z.number(),
      members: z.number(),
      live: z.number(),
      cashShare: z.number().nullable(),
    })
  ),
  delistings: z.array(
    z.object({
      contract: z.string(),
      day: z.number(),
      qty: z.number(),
      close: z.number(),
      exitPrice: z.number(),
      haircut: z.number(),
      fee: z.number(),
      /** The sleeve's PnL on its end day over the portfolio equity at the previous close. */
      dayContribution: z.number(),
    })
  ),
  leaves: z.object({ count: z.number(), traded: z.number(), cost: z.number() }),
  funding: z.object({
    contracts: z.number(),
    settlements: z.number(),
    intervalSwitches: z.number(),
    byInterval: z.record(z.string(), z.number()),
  }),
  carriedDays: z.record(z.string(), z.number()),
  gates: z.array(BroadGateSchema),
  verdict: z.enum(['fail', 'pending-trials', 'pass']),
  daily: z.object({ days: z.array(z.number()), returns: z.array(z.number()) }),
  computedAt: z.string(),
  gitCommit: z.string(),
  durationMs: z.number(),
});
export type BroadTrendReport = z.infer<typeof BroadTrendReportSchema>;

export function validateBroadTrendReport(json: unknown): ValidationResult<BroadTrendReport> {
  const result = BroadTrendReportSchema.safeParse(json);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, issues: formatIssues(result.error) };
}

// Every finite number reachable inside `pooled`, except the counts and
// indexes listed here: a sample size, a raw trial/window/year count, or an
// array index is not a "statistic" a finding should be able to cite by
// coincidence, matching checkFindings' own horizon/n exclusion above.
const EXCLUDED_POOLED_PATHS = new Set([
  'n',
  'windowsTotal',
  'windowsPositive',
  'symbolsTotal',
  'symbolsPositive',
  'benchmarkWindows',
  'trials',
  'stressTrades',
  'bootstrap.iterations',
  'bootstrap.seed',
  'bootstrap.meanBlockLen',
  'plateau.neighbors',
  // A grid cell's own parameter value (e.g. a threshold) is not a
  // statistic a finding should be able to cite by coincidence; excluded as
  // a path prefix since the key under bestParams is the family's own
  // parameter name (e.g. "threshold"), not fixed.
  'plateau.bestParams',
  'perYear[].year',
  'perYear[].trades',
]);

function isExcludedPath(path: string, excluded: Set<string>): boolean {
  if (excluded.has(path)) return true;
  for (const ex of excluded) {
    if (path.startsWith(`${ex}.`)) return true;
  }
  return false;
}

/**
 * Recursively collects every finite number reachable inside `value`
 * (objects, arrays, and tuples alike), skipping any path present in, or
 * nested under, `excluded` (see isExcludedPath -- needed for
 * plateau.bestParams, whose own keys are a grid cell's dynamic parameter
 * names). Array elements share one path suffix (`[]`) regardless of index,
 * since a finding never cites "the third entry of perYear" -- only the
 * value itself.
 */
function collectGroundableNumbers(value: unknown, path: string, excluded: Set<string>, out: number[]): void {
  if (typeof value === 'number') {
    if (isExcludedPath(path, excluded)) return;
    if (Number.isFinite(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectGroundableNumbers(item, `${path}[]`, excluded, out);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      collectGroundableNumbers(v, path ? `${path}.${key}` : key, excluded, out);
    }
  }
}

function pooledGroundableNumbers(pooled: StrategyPooledStats): number[] {
  const out: number[] = [];
  collectGroundableNumbers(pooled, '', EXCLUDED_POOLED_PATHS, out);
  return out;
}

function strategyGateValues(report: StrategyReport): number[] {
  return report.gates.map((g) => g.value).filter((v): v is number => v !== null);
}

/**
 * Grounds every headline finding in a strategy subagent's report against the
 * strategy report's own numbers. A finding with no `symbol` grounds against
 * every finite number reachable inside `report.pooled` (see
 * EXCLUDED_POOLED_PATHS for what does not count) plus every gate's `value`.
 * A finding naming a `symbol` (no `window`) grounds against that symbol's
 * `pooledOos.expectancyPercent`/`winRate`. A finding naming both `symbol` and
 * `window` grounds against that window's `oos` numbers and its
 * `benchmark.pValue`. An unknown symbol or window is ungrounded with a
 * reason naming what was not found, matching checkFindings' style above.
 */
export function checkStrategyFindings(
  sub: SubagentReport,
  report: StrategyReport
): Array<{ index: number; reason: string }> {
  const ungrounded: Array<{ index: number; reason: string }> = [];

  sub.topFindings.forEach((finding, index) => {
    if (finding.symbol === undefined) {
      const candidates = [...pooledGroundableNumbers(report.pooled), ...strategyGateValues(report)];
      if (!valueMatchesAny(finding.value, candidates)) {
        ungrounded.push({ index, reason: `value ${finding.value} not found in pooled report` });
      }
      return;
    }

    const symbolEntry = report.perSymbol.find((p) => p.symbol === finding.symbol);
    if (!symbolEntry) {
      ungrounded.push({ index, reason: `symbol "${finding.symbol}" not found in report` });
      return;
    }

    if (finding.window === undefined) {
      const candidates = [symbolEntry.pooledOos.expectancyPercent, symbolEntry.pooledOos.winRate].filter(
        (v): v is number => v !== null
      );
      if (!valueMatchesAny(finding.value, candidates)) {
        ungrounded.push({
          index,
          reason: `value ${finding.value} not found for symbol "${finding.symbol}"`,
        });
      }
      return;
    }

    const window = symbolEntry.windows[finding.window];
    if (!window) {
      ungrounded.push({
        index,
        reason: `window ${finding.window} not found for symbol "${finding.symbol}"`,
      });
      return;
    }

    const candidates: number[] = [];
    if (window.oos) {
      candidates.push(
        ...[
          window.oos.expectancyPercent,
          window.oos.expectancyR,
          window.oos.winRate,
          window.oos.profitFactor,
          window.oos.maxDrawdownPercent,
          window.oos.medianHoldBars,
        ].filter((v): v is number => v !== null)
      );
    }
    if (window.benchmark && window.benchmark.pValue !== null) {
      candidates.push(window.benchmark.pValue);
    }

    if (!valueMatchesAny(finding.value, candidates)) {
      ungrounded.push({
        index,
        reason: `value ${finding.value} not found for symbol "${finding.symbol}" window ${finding.window}`,
      });
    }
  });

  return ungrounded;
}

/**
 * Compares a freshly recomputed window (trades, expectancyPercent) against
 * the report's own recorded oos values for that symbol/window, to catch a
 * fabricated or drifted report. `trades` must match exactly; expectancyPercent
 * is tolerant of float drift (1e-9) and treats two nulls as a match (both
 * runs agreeing the window produced no usable expectancy). A missing symbol
 * or window, or a window the report itself recorded as skipped (no `oos`),
 * cannot be spot-checked and returns ok: false with a NaN delta.
 */
export function spotCheckStrategyWindow(
  report: StrategyReport,
  cell: { symbol: string; window: number },
  recomputed: { trades: number; expectancyPercent: number | null }
): { ok: boolean; deltaExpectancy: number; tradesMatch: boolean } {
  const symbolEntry = report.perSymbol.find((p) => p.symbol === cell.symbol);
  const window = symbolEntry?.windows[cell.window];

  if (!symbolEntry || !window || window.oos === null) {
    return { ok: false, deltaExpectancy: NaN, tradesMatch: false };
  }

  const tradesMatch = recomputed.trades === window.oos.trades;

  let deltaExpectancy: number;
  let expectancyOk: boolean;
  if (recomputed.expectancyPercent === null && window.oos.expectancyPercent === null) {
    deltaExpectancy = 0;
    expectancyOk = true;
  } else if (recomputed.expectancyPercent === null || window.oos.expectancyPercent === null) {
    deltaExpectancy = NaN;
    expectancyOk = false;
  } else {
    deltaExpectancy = recomputed.expectancyPercent - window.oos.expectancyPercent;
    expectancyOk = Math.abs(deltaExpectancy) <= 1e-9;
  }

  return { ok: tradesMatch && expectancyOk, deltaExpectancy, tradesMatch };
}
