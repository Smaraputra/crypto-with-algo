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
 * RESULTS, 2026-09-26. Full CLI output over the five local reports:
 *   npx tsx scripts/research/composite-audit.ts --reports
 *   data/research/reports/factor-ic-5m-p3b-lag1.json,data/research/reports/factor-ic-15m-pB-ts.json,
 *   data/research/reports/factor-ic-1h-pB-ts.json,data/research/reports/factor-ic-4h-pB-ts.json,
 *   data/research/reports/factor-ic-1d-p3b-lag1.json
 *
 * (a) Every live signal, ic and live-sign agreement (+ agrees, - disagrees,
 * . absent) per interval:
 *
 *   signal              5m ic     5m  15m ic    15m  1h ic     1h  4h ic     4h  1d ic     1d
 *   EMA Cross          -0.0330    -  -0.0244     -  -0.0123     -   0.0264    +   0.0280    +
 *   SMA Trend          -0.0312    -  -0.0333     -  -0.0091     -   0.0493    +   0.0317    +
 *   Ichimoku            .         .  -0.0216     -  -0.0060     -   0.0102    +   0.0232    +
 *   SuperTrend         -0.0273    -  -0.0238     -  -0.0089     -   0.0302    +   0.0221    +
 *   RSI                 0.0040    +   0.0029     +  -0.0090     -  -0.0008    -   0.0033    +
 *   MACD               -0.0224    -  -0.0250     -  -0.0116     -   0.0308    +   0.0444    +
 *   StochRSI            0.0064    +  -0.0053     -   0.0046     +  -0.0015    -  -0.0628    -
 *   Williams %R          0.0218    +   0.0106     +   0.0072     +  -0.0023    -  -0.0721    -
 *   OBV                -0.0243    -  -0.0050     -  -0.0106     -   0.0008    +   0.0706    +
 *   MFI                 0.0036    +   0.0043     +  -0.0092     -  -0.0025    -   0.0680    +
 *   Volume             -0.0125    -  -0.0007     -  -0.0058     -   0.0029    +   0.0337    +
 *   Taker Flow         -0.0123    -  -0.0002     -  -0.0008     -   0.0039    +   0.0219    +
 *   Bollinger           0.0261    +   0.0146     +   0.0170     +  -0.0024    -  -0.0441    -
 *   Funding Rate         0.0079    +   0.0066     +   0.0032     +  -0.0310    -  -0.0218    -
 *   Long/Short Ratio     0.0065    +   0.0185     +   0.0309     +   0.0798    +   0.1502    +
 *   Fear & Greed         0.0052    +   0.0003     +  -0.0155     -  -0.0552    -  -0.0864    -
 *   News                 0.0413    +  -0.0458     -   0.1183     +   0.2194    +   0.2582    +
 *   HTF EMA Cross      -0.0218    -  -0.0391     -  -0.0084     -   0.0205    +   .          .
 *   HTF SMA Trend      -0.0282    -  -0.0293     -  -0.0032     -   0.0348    +   .          .
 *   HTF SuperTrend     -0.0260    -  -0.0308     -  -0.0013     -   0.0242    +   .          .
 *
 * (b) Per interval, exactly as the CLI printed it:
 *
 *   === 5m (scalping) -- report factor-ic-5m-p3b-lag1.json ===
 *   category      weight   ic       t       contribution
 *   trend         0.0850  -0.0334  -10.03  -0.002835
 *   momentum      0.3400   0.0070    3.57   0.002390
 *   volume        0.2550  -0.0095   -6.80  -0.002420
 *   volatility    0.1275   0.0261   12.88   0.003322
 *   futures       0.0425   0.0085    2.46   0.000362
 *   sentiment     0.0000   0.0053    1.53   0.000000
 *   htf           0.1500  -0.0298   -8.58  -0.004472
 *   composite ic -0.0151 t -5.70
 *   additive sum -0.003653
 *   additive ceiling 0.015802
 *   missing categories: none
 *   cost lines (sd 0.78%/trade):
 *     standard taker be 0.1282 (cost 0.200%), maker be 0.0256 (cost 0.040%)
 *     bnb taker be 0.1218 (cost 0.190%), maker be 0.0231 (cost 0.036%)
 *     promo-btc-eth-2026-07 taker be 0.1103 (cost 0.172%), maker be 0.0000 (cost 0.000%)
 *   horizon 16 (outcome horizon 12 for scalping)
 *
 *   === 15m (day_trading) -- report factor-ic-15m-pB-ts.json ===
 *   category      weight   ic       t      contribution
 *   trend         0.2125  -0.0303   -4.64  -0.006436
 *   momentum      0.2550  -0.0123   -2.88  -0.003145
 *   volume        0.1700   0.0019    0.43   0.000326
 *   volatility    0.0850   0.0146    3.27   0.001242
 *   futures       0.0850   0.0213    2.72   0.001807
 *   sentiment     0.0425   0.0001    0.02   0.000005
 *   htf           0.1500  -0.0394   -5.14  -0.005916
 *   composite ic -0.0344 t -5.00
 *   additive sum -0.012117
 *   additive ceiling 0.018879
 *   missing categories: none
 *   cost lines (sd 2.04%/trade):
 *     standard taker be 0.0392 (cost 0.160%), maker be 0.0098 (cost 0.040%)
 *     bnb taker be 0.0368 (cost 0.150%), maker be 0.0088 (cost 0.036%)
 *     promo-btc-eth-2026-07 taker be 0.0324 (cost 0.132%), maker be 0.0000 (cost 0.000%)
 *   horizon 32 (outcome horizon 24 for day_trading)
 *
 *   === 1h (day_trading) -- report factor-ic-1h-pB-ts.json ===
 *   category      weight   ic       t      contribution
 *   trend         0.2125  -0.0105   -1.79  -0.002241
 *   momentum      0.2550  -0.0020   -0.53  -0.000511
 *   volume        0.1700  -0.0129   -3.26  -0.002185
 *   volatility    0.0850   0.0170    4.15   0.001447
 *   futures       0.0850   0.0106    1.53   0.000904
 *   sentiment     0.0425  -0.0155   -2.17  -0.000659
 *   htf           0.1500  -0.0097   -1.46  -0.001457
 *   composite ic -0.0086 t -1.40
 *   additive sum -0.004702
 *   additive ceiling 0.009404
 *   missing categories: none
 *   cost lines (sd 4.56%/trade):
 *     standard taker be 0.0175 (cost 0.160%), maker be 0.0044 (cost 0.040%)
 *     bnb taker be 0.0164 (cost 0.150%), maker be 0.0039 (cost 0.036%)
 *     promo-btc-eth-2026-07 taker be 0.0145 (cost 0.132%), maker be 0.0000 (cost 0.000%)
 *   horizon 32 (outcome horizon 24 for day_trading)
 *
 *   === 4h (swing_trading) -- report factor-ic-4h-pB-ts.json ===
 *   category      weight   ic       t      contribution
 *   trend         0.2700   0.0324    3.15   0.008735
 *   momentum      0.1800   0.0138    2.03   0.002492
 *   volume        0.0900  -0.0026   -0.41  -0.000233
 *   volatility    0.0900  -0.0024   -0.36  -0.000220
 *   futures       0.1800   0.0331    2.91   0.005961
 *   sentiment     0.0900  -0.0552   -4.73  -0.004966
 *   htf           0.1000   0.0235    1.99   0.002352
 *   composite ic 0.0374 t 3.60
 *   additive sum 0.014122
 *   additive ceiling 0.024960
 *   missing categories: none
 *   cost lines (sd 9.21%/trade):
 *     standard taker be 0.0076 (cost 0.140%), maker be 0.0022 (cost 0.040%)
 *     bnb taker be 0.0071 (cost 0.130%), maker be 0.0020 (cost 0.036%)
 *     promo-btc-eth-2026-07 taker be 0.0061 (cost 0.112%), maker be 0.0000 (cost 0.000%)
 *   horizon 32 (outcome horizon 30 for swing_trading)
 *
 *   === 1d (position_trading) -- report factor-ic-1d-p3b-lag1.json ===
 *   category      weight   ic       t      contribution
 *   trend         0.3500   0.0298    1.37   0.010423
 *   momentum      0.1000  -0.0331   -1.83  -0.003315
 *   volume        0.0500   0.0753    4.95   0.003767
 *   volatility    0.0500  -0.0441   -2.58  -0.002207
 *   futures       0.2500   0.0463    2.39   0.011566
 *   sentiment     0.2000  -0.0864   -4.05  -0.017272
 *   composite ic 0.0110 t 0.53
 *   additive sum 0.002962
 *   additive ceiling 0.048550
 *   missing categories: htf
 *   cost lines (sd 15.92%/trade):
 *     standard taker be 0.0044 (cost 0.140%), maker be 0.0013 (cost 0.040%)
 *     bnb taker be 0.0041 (cost 0.130%), maker be 0.0011 (cost 0.036%)
 *     promo-btc-eth-2026-07 taker be 0.0035 (cost 0.112%), maker be 0.0000 (cost 0.000%)
 *   horizon 16 (outcome horizon 20 for position_trading)
 *
 * (c) Reading: at 5m, 15m and 1h every trend, HTF and volume component
 * enters with the wrong sign at the outcome horizon; the momentum category
 * is mixed rather than uniform: MACD is wrong-signed at all three, Williams
 * %R right-signed at all three, RSI wrong-signed only at 1h (positive at 5m
 * +0.0040 and 15m +0.0029, the exception there), and StochRSI wrong-signed
 * only at 15m (-0.0053, positive at 5m +0.0064 and 1h +0.0046). Bollinger,
 * the volatility category, enters with the right sign at all three. At 1h
 * the Long/Short Ratio signal reads +0.0309 (t 3.89) at h32, the only
 * futures-category reading that agrees strongly; News rows are sparse
 * (marked `(hN, not hM)` at 4h and 1d, t 1.28 and 0.71) and uninformative.
 * The ceiling is generous by construction (every category flipped to its
 * measured sign, correlations ignored) and it still sits below the
 * cheapest taker line at 5m, 15m and 1h, so no re-weighting of these
 * inputs pays taker costs at the intervals the user trades. At 4h and 1d
 * the ceiling clears the line where the sample is too small to prove a
 * rule (the record's Phase 4, 4b, 4c verdicts stand). `fade-composite`
 * already failed at 1h (Phase 4), so flipping signs wholesale is not a
 * new experiment.
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
