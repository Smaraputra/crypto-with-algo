/**
 * The composite sign audit: for each style's interval, which live signal
 * components enter the composite with the wrong sign, how much nominal
 * weight they carry, what the composite itself measures at that interval,
 * and an additive ceiling a re-weighting could not exceed.
 *
 * WHY. The live composite score is a weighted sum of seven category means
 * (trend, momentum, volume, volatility, futures, sentiment, htf), each the
 * mean of a few indicator readings (src/lib/signals/scorer.ts). The research
 * track measures every reading's lag-1 information coefficient against
 * forward returns and stores the result in factor-ic report JSON files
 * (data/research/reports/factor-ic-<interval>-*.json, schema in
 * report-schema.ts). This script reads such a report and restates it in the
 * composite's own terms.
 *
 * SEMANTICS. In a factor-ic report, a `sig.<name>` factor is the scorer's
 * own reading (direction times strength) for that indicator, so a positive
 * pooled IC means the live sign is right at that interval and a negative one
 * means the scorer votes the wrong way. `cat.<category>` is the category
 * mean and `composite` is the whole live score. Weights are the style's
 * nominal DEFAULT_TEMPLATE_WEIGHTS -- the live scorer redistributes a
 * missing category's weight across the rest at run time, which this table
 * ignores, so a weight shown here is the design weight, not necessarily what
 * a given live bar actually applied. The additive sum
 * (sum_c weight_c * IC(cat_c)) is a rough approximation of the composite's
 * own IC, not a measurement of it -- it ignores correlation between
 * categories and nonlinearity in how the composite is thresholded into tiers.
 * The additive ceiling (sum_c weight_c * |IC(cat_c)|) is what a re-weighting
 * could reach only if every category were flipped to its measured sign and
 * every category were uncorrelated with every other; it is generous by
 * construction and should be read as an upper bound, never a target.
 *
 * Usage:
 *   npx tsx scripts/research/composite-audit.ts --reports a.json,b.json [--sd-percent 4.56] [--horizon 32]
 *   --sd-percent overrides RECORDED_CONTROL_SD_PERCENT for every report in
 *   the run (that table only covers 5m/15m/1h/4h/1d); --horizon overrides
 *   the per-style outcome-horizon nearest-match for every report in the run.
 *
 * RESULTS: Results recorded by Task 7 of the 2026-09-26 audit plan.
 */
import { readFile } from 'fs/promises';
import {
  FEE_PROFILE_NAMES,
  defaultCostPercent,
  resolveFeeProfile,
  type FeeProfileName,
} from '@/lib/backtest/cost-model';
import { DEFAULT_TEMPLATE_WEIGHTS, type TradingStyle } from '@/lib/models/signal-template';
import { OUTCOME_HORIZON_BARS } from '@/lib/signals/outcome-horizons';
import { styleForInterval } from './factors';
import { RECORDED_CONTROL_SD_PERCENT } from './frontier';
import { validateFactorIcReport, type FactorIcReport, type FactorReport, type HorizonStat } from './report-schema';

export type SignalCategory = 'trend' | 'momentum' | 'volume' | 'volatility' | 'futures' | 'sentiment' | 'htf';

/** Every category in the order the composite's own weight record uses. */
const CATEGORY_ORDER: readonly SignalCategory[] = [
  'trend',
  'momentum',
  'volume',
  'volatility',
  'futures',
  'sentiment',
  'htf',
];

/**
 * Live signal name (the part after "sig.") to its scoring category.
 * Verified against src/lib/indicators/interpret.ts:482-518 (trend, momentum,
 * volatility, volume signal groups) and src/lib/signals/scorer.ts
 * (SuperTrend appended in scoreTrend, futures/sentiment/htf assembled from
 * their own inputs). ATR is deliberately absent: scoreVolatility excludes it
 * from the category mean because it never carries a direction, so it never
 * votes and never appears as a `sig.*` factor -- only under skippedFactors.
 */
export const SIGNAL_CATEGORY: Record<string, SignalCategory> = {
  'EMA Cross': 'trend',
  'SMA Trend': 'trend',
  Ichimoku: 'trend',
  SuperTrend: 'trend',
  RSI: 'momentum',
  MACD: 'momentum',
  StochRSI: 'momentum',
  'Williams %R': 'momentum',
  OBV: 'volume',
  MFI: 'volume',
  Volume: 'volume',
  'Taker Flow': 'volume',
  Bollinger: 'volatility',
  'Funding Rate': 'futures',
  'Long/Short Ratio': 'futures',
  'Fear & Greed': 'sentiment',
  News: 'sentiment',
  'HTF EMA Cross': 'htf',
  'HTF SMA Trend': 'htf',
  'HTF SuperTrend': 'htf',
};

/**
 * Nearest report horizon to the style's outcome horizon, ties broken toward
 * the longer horizon (the report's coarsest measurement, not its noisiest).
 */
export function pickAuditHorizon(reportHorizons: number[], outcomeHorizon: number): number {
  let best = reportHorizons[0];
  let bestDiff = Math.abs(best - outcomeHorizon);
  for (const h of reportHorizons.slice(1)) {
    const diff = Math.abs(h - outcomeHorizon);
    if (diff < bestDiff || (diff === bestDiff && h > best)) {
      best = h;
      bestDiff = diff;
    }
  }
  return best;
}

/**
 * The pooled row at `horizon`, or the nearest horizon this particular factor
 * actually reports (same nearest/tie-to-longer rule as pickAuditHorizon).
 *
 * Every factor observed in the real reports (5m/15m/1h/4h/1d, 2026-09-26)
 * reports a pooled row at every one of the report's own horizons, EXCEPT
 * sig.News, whose stored aggregate ({count, avgSentiment}) triggers rarely
 * enough that the study caps its horizon range well short of the report's
 * (h1-4 at 4h instead of h1-32, h1 only at 1d). Falling back here rather
 * than throwing lets the audit still cover every other component at the
 * intended horizon; `horizonUsed` on the row records when this happened so
 * the output never silently reports a different horizon than the one it
 * says it used.
 */
function poolRowNear(factor: FactorReport, horizon: number): { row: HorizonStat; horizonUsed: number } {
  const exact = factor.pooled.horizons.find((h) => h.horizon === horizon);
  if (exact) return { row: exact, horizonUsed: horizon };
  const available = factor.pooled.horizons.map((h) => h.horizon);
  if (available.length === 0) {
    throw new Error(`Factor "${factor.name}" has no pooled horizons at all`);
  }
  const horizonUsed = pickAuditHorizon(available, horizon);
  const row = factor.pooled.horizons.find((h) => h.horizon === horizonUsed)!;
  return { row, horizonUsed };
}

export interface AuditSignalRow {
  name: string;
  category: SignalCategory;
  weight: number;
  ic: number;
  icT: number;
  n: number;
  liveSignAgrees: boolean;
  /** The horizon this row's ic/icT actually came from; differs from the
   * audit's chosen horizon only when this factor has no row there (see
   * poolRowNear). */
  horizonUsed: number;
}

export interface AuditCategoryRow {
  category: SignalCategory;
  weight: number;
  ic: number;
  icT: number;
  contribution: number;
  horizonUsed: number;
}

export interface CostLine {
  profile: FeeProfileName;
  takerCostPercent: number;
  makerCostPercent: number;
  breakevenIcTaker: number;
  breakevenIcMaker: number;
}

export interface CompositeAudit {
  interval: string;
  style: TradingStyle;
  horizon: number;
  outcomeHorizon: number;
  gitCommit: string;
  computedAt: string;
  signals: AuditSignalRow[];
  categories: AuditCategoryRow[];
  compositeIc: number;
  compositeT: number;
  compositeHorizonUsed: number;
  additiveSum: number;
  additiveCeiling: number;
  categoriesMissing: SignalCategory[];
  /** Categories present as a cat.* factor but with no pooled row at the
   * exact audit horizon. Their `categories` row still displays the nearest
   * available row (ic/icT, marked with horizonUsed), but that substituted
   * row is excluded from additiveSum and additiveCeiling -- a fallback
   * value must never enter either sum (controller ruling, 2026-09-26 review
   * of this task). Its `contribution` is NaN. */
  categoriesWithoutHorizonRow: SignalCategory[];
  sdPercent: number;
  costLines: CostLine[];
}

export interface AuditComposeOptions {
  sdPercent?: number;
  horizon?: number;
}

export function auditComposite(report: FactorIcReport, options: AuditComposeOptions = {}): CompositeAudit {
  const style = styleForInterval(report.interval);
  const outcomeHorizon = OUTCOME_HORIZON_BARS[style];
  const horizon = options.horizon ?? pickAuditHorizon(report.horizons, outcomeHorizon);
  const weights = DEFAULT_TEMPLATE_WEIGHTS[style];

  const signals: AuditSignalRow[] = [];
  const categoriesPresent = new Map<SignalCategory, AuditCategoryRow>();
  const categoriesWithoutHorizonRowSet = new Set<SignalCategory>();
  let compositeIc = NaN;
  let compositeT = NaN;
  let compositeHorizonUsed = horizon;

  for (const factor of report.factors) {
    if (factor.name === 'composite') {
      // Display-only fallback: the composite row never enters a sum, so a
      // substituted horizon here is informational only.
      const { row, horizonUsed } = poolRowNear(factor, horizon);
      compositeIc = row.ic;
      compositeT = row.icT;
      compositeHorizonUsed = horizonUsed;
      continue;
    }
    if (factor.name.startsWith('cat.')) {
      const category = factor.name.slice('cat.'.length) as SignalCategory;
      const weight = weights[category];
      // A cat.* row with no EXACT row at the audit horizon must not feed
      // additiveSum/additiveCeiling with a substituted value (controller
      // ruling, 2026-09-26 review). It still displays using the nearest
      // available row, marked via horizonUsed, but its contribution is NaN
      // and it is tracked in categoriesWithoutHorizonRowSet so both sums
      // can exclude it explicitly rather than relying on NaN propagation.
      const exact = factor.pooled.horizons.find((h) => h.horizon === horizon);
      if (exact) {
        categoriesPresent.set(category, {
          category,
          weight,
          ic: exact.ic,
          icT: exact.icT,
          contribution: weight * exact.ic,
          horizonUsed: horizon,
        });
      } else {
        const { row, horizonUsed } = poolRowNear(factor, horizon);
        categoriesPresent.set(category, {
          category,
          weight,
          ic: row.ic,
          icT: row.icT,
          contribution: NaN,
          horizonUsed,
        });
        categoriesWithoutHorizonRowSet.add(category);
      }
      continue;
    }
    if (factor.name.startsWith('sig.')) {
      const name = factor.name.slice('sig.'.length);
      const category = SIGNAL_CATEGORY[name];
      if (!category) {
        throw new Error(`Unmapped signal: ${name}`);
      }
      const { row, horizonUsed } = poolRowNear(factor, horizon);
      signals.push({
        name,
        category,
        weight: weights[category],
        ic: row.ic,
        icT: row.icT,
        n: row.n,
        liveSignAgrees: row.ic > 0,
        horizonUsed,
      });
      continue;
    }
    // raw.* inputs and anything else are not part of the composite; skip.
  }

  const categories = CATEGORY_ORDER.filter((c) => categoriesPresent.has(c)).map((c) => categoriesPresent.get(c)!);
  const categoriesMissing = CATEGORY_ORDER.filter((c) => !categoriesPresent.has(c));
  const categoriesWithoutHorizonRow = CATEGORY_ORDER.filter((c) => categoriesWithoutHorizonRowSet.has(c));
  // Only a category with an EXACT row at the audit horizon may enter either
  // sum; a substituted (fallback) row must not, per the controller ruling.
  const summableCategories = categories.filter((c) => !categoriesWithoutHorizonRowSet.has(c.category));
  const additiveSum = summableCategories.reduce((sum, c) => sum + c.contribution, 0);
  const additiveCeiling = summableCategories.reduce((sum, c) => sum + c.weight * Math.abs(c.ic), 0);

  const sdPercent = options.sdPercent ?? RECORDED_CONTROL_SD_PERCENT[report.interval];
  if (sdPercent === undefined) {
    throw new Error(
      `No recorded control sd% for interval "${report.interval}"; pass --sd-percent explicitly`
    );
  }

  const costLines: CostLine[] = FEE_PROFILE_NAMES.map((profile) => {
    const takerCostPercent = defaultCostPercent(report.interval, { profile, symbol: 'BTCUSDT' });
    const makerCostPercent = 2 * resolveFeeProfile(profile, 'BTCUSDT').makerFee * 100;
    return {
      profile,
      takerCostPercent,
      makerCostPercent,
      breakevenIcTaker: takerCostPercent / (2 * sdPercent),
      breakevenIcMaker: makerCostPercent / (2 * sdPercent),
    };
  });

  return {
    interval: report.interval,
    style,
    horizon,
    outcomeHorizon,
    gitCommit: report.gitCommit,
    computedAt: report.computedAt,
    signals,
    categories,
    compositeIc,
    compositeT,
    compositeHorizonUsed,
    additiveSum,
    additiveCeiling,
    categoriesMissing,
    categoriesWithoutHorizonRow,
    sdPercent,
    costLines,
  };
}

function fmt(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

export function formatCompositeAudit(audit: CompositeAudit): string {
  const lines: string[] = [];
  lines.push(
    `=== ${audit.interval} (${audit.style}) -- gitCommit ${audit.gitCommit}, computedAt ${audit.computedAt} ===`
  );

  lines.push('signals:');
  lines.push(
    ['name', 'category', 'weight', 'ic', 't', 'agrees'].map((h, i) => h.padEnd(i === 0 ? 20 : 16)).join('')
  );
  for (const s of audit.signals) {
    const note = s.horizonUsed !== audit.horizon ? ` (h${s.horizonUsed}, not h${audit.horizon})` : '';
    lines.push(
      [
        s.name.padEnd(20),
        s.category.padEnd(16),
        fmt(s.weight, 4).padEnd(16),
        fmt(s.ic, 4).padEnd(16),
        fmt(s.icT, 2).padEnd(16),
        (s.liveSignAgrees ? 'yes' : 'no') + note,
      ].join('')
    );
  }

  lines.push('categories:');
  lines.push(
    ['category', 'weight', 'ic', 't', 'contribution'].map((h) => h.padEnd(16)).join('')
  );
  for (const c of audit.categories) {
    const note = c.horizonUsed !== audit.horizon ? ` (h${c.horizonUsed}, not h${audit.horizon})` : '';
    lines.push(
      [
        c.category.padEnd(16),
        fmt(c.weight, 4).padEnd(16),
        fmt(c.ic, 4).padEnd(16),
        fmt(c.icT, 2).padEnd(16),
        fmt(c.contribution, 6) + note,
      ].join('')
    );
  }

  const compositeNote =
    audit.compositeHorizonUsed !== audit.horizon
      ? ` (h${audit.compositeHorizonUsed}, not h${audit.horizon})`
      : '';
  lines.push(`composite ic ${fmt(audit.compositeIc, 4)} t ${fmt(audit.compositeT, 2)}${compositeNote}`);
  lines.push(`additive sum ${fmt(audit.additiveSum, 6)}`);
  lines.push(`additive ceiling ${fmt(audit.additiveCeiling, 6)}`);
  lines.push(
    `missing categories: ${audit.categoriesMissing.length > 0 ? audit.categoriesMissing.join(', ') : 'none'}`
  );
  lines.push(
    `categories without a row at h${audit.horizon}: ${
      audit.categoriesWithoutHorizonRow.length > 0 ? audit.categoriesWithoutHorizonRow.join(', ') : 'none'
    }`
  );

  lines.push(`cost lines (sd ${fmt(audit.sdPercent, 2)}%/trade):`);
  for (const c of audit.costLines) {
    lines.push(
      `  ${c.profile} taker be ${fmt(c.breakevenIcTaker, 4)} (cost ${fmt(c.takerCostPercent, 3)}%), ` +
        `maker be ${fmt(c.breakevenIcMaker, 4)} (cost ${fmt(c.makerCostPercent, 3)}%)`
    );
  }

  lines.push(`horizon ${audit.horizon} (outcome horizon ${audit.outcomeHorizon} for ${audit.style})`);

  return lines.join('\n');
}

// Every flag this CLI takes. An unrecognized --flag is rejected rather than
// silently absorbed as a no-op, the same rule frontier.ts and factor-ic.ts
// apply: a typo must fail loudly, not quietly print the defaults.
const VALUE_FLAGS = new Set(['reports', 'sd-percent', 'horizon']);

function finiteNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${flag} must be a finite number, got "${raw}"`);
  }
  return value;
}

export interface CompositeAuditArgs {
  reports: string[];
  sdPercent?: number;
  horizon?: number;
}

export function parseArgs(argv: string[]): CompositeAuditArgs {
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
  if (!reportsRaw) throw new Error('--reports is required (comma-separated factor-ic report paths)');
  const reports = reportsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    reports,
    sdPercent: flags.has('sd-percent') ? finiteNumber(flags.get('sd-percent')!, 'sd-percent') : undefined,
    horizon: flags.has('horizon') ? finiteNumber(flags.get('horizon')!, 'horizon') : undefined,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outputs: string[] = [];
  for (const path of args.reports) {
    const json = JSON.parse(await readFile(path, 'utf8'));
    const validated = validateFactorIcReport(json);
    if (!validated.ok) {
      throw new Error(`${path} failed schema validation:\n${validated.issues.join('\n')}`);
    }
    const audit = auditComposite(validated.data, { sdPercent: args.sdPercent, horizon: args.horizon });
    outputs.push(formatCompositeAudit(audit));
  }
  console.log(outputs.join('\n\n'));
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
