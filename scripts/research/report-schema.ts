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
  }),
  factors: z.array(FactorReportSchema),
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
 */
export const SURVIVOR_RULE = {
  minAbsIc: 0.02,
  minT: 2.5,
  minHorizons: 2,
  minQuarterAgreement: 0.6,
  minSymbolAgreement: 0.7,
} as const;

export interface SurvivorRow {
  interval: string;
  factor: string;
  category: string;
  sign: 1 | -1 | 0;
  horizonsPassing: number[];
  quarterAgreement: number;
  symbolAgreement: number;
  survivor: boolean;
  reasons: string[];
}

function signOf(value: number): 1 | -1 | 0 {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

function evaluateFactorSurvivor(interval: string, factor: FactorReport): SurvivorRow {
  const passing = factor.pooled.horizons.filter(
    (h) => Math.abs(h.ic) >= SURVIVOR_RULE.minAbsIc && Math.abs(h.icT) >= SURVIVOR_RULE.minT
  );
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
    factor: factor.name,
    category: factor.category,
    sign,
    horizonsPassing,
    quarterAgreement,
    symbolAgreement,
    survivor: reasons.length === 0,
    reasons,
  };
}

export function evaluateSurvivors(report: FactorIcReport): SurvivorRow[] {
  return report.factors.map((factor) => evaluateFactorSurvivor(report.interval, factor));
}

function horizonStatNumbers(stat: HorizonStat): number[] {
  const numbers = [
    stat.horizon,
    stat.n,
    stat.ic,
    stat.icT,
    stat.nNonOverlapping,
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
  return [entry.horizon, entry.ic, entry.n, entry.t];
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
 * matching HorizonStat/rolling entries, not just the one `metric` names.
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
