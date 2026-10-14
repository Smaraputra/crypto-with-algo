/**
 * Synthetic 8h universes for the rv-v1 re-validation calibration (header CALIBRATION ACCEPTANCE in
 * scripts/research/rv-revalidation.ts). Nothing here reads market data.
 *
 * Every mode shares one structure per symbol i and bar t: a close-to-close log return
 * r(i,t) = beta(i) * m(t) + e(i,t) [+ planted term], split into a small gap (open over previous close)
 * and the intrabar move, a high and low around the bar, a lognormal volume with a taker-buy share near
 * one half, and one funding settlement at each bar close (an 8h interval, so fundSum = fundLast).
 * - iid: m and e are driftless Gaussian, funding is a base rate plus iid noise (nothing a carry factor
 *   could trade).
 * - garch: as iid, with m and each e following GARCH(1,1) (alpha 0.10, beta 0.85).
 * - planted: the header's data generating process. A latent score s(i,t) follows AR(1) with coefficient
 *   0.95 and unit stationary variance. The next bar's return gains kappa * s(i,t), the funding settled at
 *   bar t is minus c * s(i,t) plus noise (so carry reads the score and funding persists), and volume and
 *   taker-buy share carry a weak positive loading on s(i,t).
 * `strength` scales every planted loading (kappa, c and both volume loadings), and 1 is the calibrated edge.
 * The driftless modes take strength 0 and reject anything else.
 */
import {
  RV_V1,
  rvComposite,
  rvFactors,
  rvInitialState,
  rvStep,
  rvTargets,
  type RvFillBar,
  type RvSettlement,
  type RvSymbolInput,
} from '@/lib/signals/cross-sectional/engine';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import { RV_SYMBOLS, type RvPanel } from './rv-panel';

const BAR_MS = RV_V1.barMs;

/** Annualisation factor for a per-bar Sharpe on 8h bars: sqrt(365.25 * 3) (header OBJECTIVE). */
export const ANNUALISATION = Math.sqrt(365.25 * 3);

/** First bar open of every synthetic panel (an 8h boundary). */
export const SYNTHETIC_T0 = Date.UTC(2022, 0, 1);

/** Header CALIBRATION: the latent score's AR(1) coefficient. */
export const PLANTED_AR = 0.95;

/**
 * Header CALIBRATION: kappa, the next-bar log return per unit of latent score, fixed once so that rv-v1's
 * annualised net taker Sharpe on a 3,000-bar, 10-symbol planted panel lies in [3, 4]. Chosen on a grid of
 * step 0.00002 as the value whose mean over the ten header planted seeds (base + 210,000 + k, k = 1..10),
 * measured with rvV1NetTakerReturns, is closest to the band centre 3.5. At 0.00146 the ten Sharpes are
 * 3.635, 3.602, 4.159, 3.343, 3.631, 3.819, 2.341, 3.328, 3.336, 3.850 (k = 1..10): mean 3.504, 8 of 10
 * inside [3, 4]. The spread is sampling noise (sd about 0.5 annualised at 3,000 bars), so a fresh seed
 * set would not always put 8 of 10 inside the band.
 */
export const PLANTED_KAPPA = 0.00146;

/** Funding loading: the settled rate is FUNDING_BASE - c * s + noise. */
export const PLANTED_FUNDING_C = 0.0001;
/** Taker-buy share loading per unit of score (weak). */
export const PLANTED_FLOW_LOADING = 0.001;
/** Log volume loading per unit of score (weak). */
export const PLANTED_VOLUME_LOADING = 0.05;

const MARKET_SD = 0.02;
/**
 * Per symbol (RV_SYMBOLS order): beta to the market factor and idiosyncratic 8h sd. Fixed rather than drawn
 * per seed, so every seed of a mode shares one population edge and seeds differ only by sampling noise.
 * BTCUSDT is the market (beta 1, small own noise). Alt betas 0.95 to 1.4 and sds 1.2% to 2.0% give a
 * pairwise return correlation of about 0.7 (0.711 on iid seed base + 200,001), close to the real majors.
 */
const BETA = [1, 1.1, 0.95, 1.3, 1.05, 1.15, 1.25, 1.4, 1.2, 1.2];
const IDIO_SD = [0.005, 0.012, 0.013, 0.02, 0.018, 0.015, 0.019, 0.018, 0.015, 0.016];
const GAP_SD = 1e-4;
const RANGE_SD = 0.006;
const VOLUME_LOG_SD = 0.3;
const SHARE_SD = 0.02;
const FUNDING_BASE = 0.0001;
const FUNDING_NOISE_SD = 0.00005;
const GARCH_ALPHA = 0.1;
const GARCH_BETA = 0.85;
const START_PRICES = [40_000, 3_000, 400, 150, 0.8, 1.2, 0.15, 80, 25, 20];

export type SyntheticMode = 'iid' | 'garch' | 'planted';

export interface SyntheticOptions {
  bars: number;
  symbols: number;
  mode: SyntheticMode;
  strength: number;
  seed: number;
}

function gaussian(random: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random());
}

/** A GARCH(1,1) innovation stream with unconditional standard deviation `sd`. */
function garchStream(sd: number, z: () => number): () => number {
  const omega = sd * sd * (1 - GARCH_ALPHA - GARCH_BETA);
  let h = sd * sd;
  let prev = 0;
  let started = false;
  return () => {
    if (started) h = omega + GARCH_ALPHA * prev * prev + GARCH_BETA * h;
    started = true;
    prev = Math.sqrt(h) * z();
    return prev;
  };
}

export function syntheticPanel(opts: SyntheticOptions): RvPanel {
  const { bars: n, symbols: nSym, mode, strength, seed } = opts;
  if (!Number.isInteger(n) || n < 2) throw new Error(`bars must be an integer of at least 2, got ${n}`);
  if (!Number.isInteger(nSym) || nSym < 1 || nSym > RV_SYMBOLS.length) {
    throw new Error(`symbols must be an integer in [1, ${RV_SYMBOLS.length}], got ${nSym}`);
  }
  if (!Number.isInteger(seed)) throw new Error(`seed must be an integer, got ${seed}`);
  if (mode === 'planted' ? !(strength >= 0 && Number.isFinite(strength)) : strength !== 0) {
    throw new Error(`strength ${strength} is invalid for mode ${mode}: planted takes a finite strength >= 0, iid and garch take 0`);
  }

  const random = createSeededRandom(seed);
  const z = gaussian(random);
  const planted = mode === 'planted';
  const kappa = planted ? strength * PLANTED_KAPPA : 0;
  const c = planted ? strength * PLANTED_FUNDING_C : 0;
  const flowLoading = planted ? strength * PLANTED_FLOW_LOADING : 0;
  const volumeLoading = planted ? strength * PLANTED_VOLUME_LOADING : 0;

  const symbols = RV_SYMBOLS.slice(0, nSym) as string[];
  const beta = BETA.slice(0, nSym);
  const idioSd = IDIO_SD.slice(0, nSym);
  const baseVolume = symbols.map((_, i) => 1e6 / START_PRICES[i]);

  const market = mode === 'garch' ? garchStream(MARKET_SD, z) : () => MARKET_SD * z();
  const idio = symbols.map((_, i) => (mode === 'garch' ? garchStream(idioSd[i], z) : () => idioSd[i] * z()));
  const innovationSd = Math.sqrt(1 - PLANTED_AR * PLANTED_AR);
  const score = symbols.map(() => z()); // stationary start, unit variance

  const panel: RvPanel = {
    symbols,
    t: Array.from({ length: n }, (_, k) => SYNTHETIC_T0 + k * BAR_MS),
    open: symbols.map(() => []),
    high: symbols.map(() => []),
    low: symbols.map(() => []),
    close: symbols.map(() => []),
    volume: symbols.map(() => []),
    tbv: symbols.map(() => []),
    fundSum: symbols.map(() => []),
    fundLast: symbols.map(() => []),
  };
  const prevClose = symbols.map((_, i) => START_PRICES[i]);

  for (let k = 0; k < n; k++) {
    const m = market();
    for (let i = 0; i < nSym; i++) {
      // the score known at the previous close drives this bar's return
      const r = beta[i] * m + idio[i]() + (k > 0 ? kappa * score[i] : 0);
      if (k > 0) score[i] = PLANTED_AR * score[i] + innovationSd * z();
      const s = score[i];

      const gap = k === 0 ? 0 : GAP_SD * z();
      const open = prevClose[i] * Math.exp(gap);
      const close = open * Math.exp(r - gap);
      const high = Math.max(open, close) * Math.exp(Math.abs(z()) * RANGE_SD);
      const low = Math.min(open, close) * Math.exp(-Math.abs(z()) * RANGE_SD);
      const volume = baseVolume[i] * Math.exp(VOLUME_LOG_SD * z() + volumeLoading * s);
      const share = Math.min(0.95, Math.max(0.05, 0.5 + flowLoading * s + SHARE_SD * z()));
      const rate = FUNDING_BASE - c * s + FUNDING_NOISE_SD * z();

      panel.open[i].push(open);
      panel.high[i].push(high);
      panel.low[i].push(low);
      panel.close[i].push(close);
      panel.volume[i].push(volume);
      panel.tbv[i].push(volume * share);
      panel.fundSum[i].push(rate);
      panel.fundLast[i].push(rate);
      prevClose[i] = close;
    }
  }
  return panel;
}

/**
 * The reference rv-v1 run (cell 11, the engine's RV_V1) on a panel, taker track: the signal at bar k's
 * close uses bars k - 42..k and the carry input fundLast of bar k stamped at bar k's close. The fill is at
 * bar k + 1's open. The funding settled over bar k is one settlement { bar close, fundSum, markPrice null }.
 * Returns equityAfter of each step over equityAfter of the step before (the starting equity for the
 * first), so each value is one open-to-open net return including funding and costs. This fixes
 * PLANTED_KAPPA, and Task 7B's runCells must reproduce it for cell 11.
 */
export function rvV1NetTakerReturns(panel: RvPanel): number[] {
  const n = panel.t.length;
  for (let k = 1; k < n; k++) {
    if (panel.t[k] - panel.t[k - 1] !== BAR_MS) throw new Error(`The panel is not contiguous at bar ${k}`);
  }
  const window = RV_V1.flowBars;
  let state = rvInitialState();
  let prevFillTime: number | null = null;
  let prevEquity: number = RV_V1.startingEquity;
  const out: number[] = [];

  for (let k = window - 1; k + 1 < n; k++) {
    const barClose = panel.t[k] + BAR_MS;
    const inputs: RvSymbolInput[] = panel.symbols.map((symbol, s) => {
      const bars = [];
      for (let j = k - window + 1; j <= k; j++) {
        bars.push({ openTime: panel.t[j], close: panel.close[s][j], volume: panel.volume[s][j], takerBuyVolume: panel.tbv[s][j] });
      }
      const rate = panel.fundLast[s][k];
      return { symbol, bars, lastSettlement: rate === null ? null : { fundingTime: barClose, rate, markPrice: null } };
    });
    const factors = rvFactors(inputs, panel.t[k]);
    const ranked = rvComposite(factors.rows, RV_V1.weights);
    const betas = new Map(factors.rows.map((r) => [r.symbol, r.beta]));
    const held = new Map<string, 1 | -1>();
    for (const [symbol, p] of Object.entries(state.positions)) if (p.qty !== 0) held.set(symbol, p.qty > 0 ? 1 : -1);
    const targets = rvTargets(ranked, held, betas);

    const fillBars: Record<string, RvFillBar> = {};
    const settlements: Record<string, RvSettlement[]> = {};
    panel.symbols.forEach((symbol, s) => {
      fillBars[symbol] = { open: panel.open[s][k + 1], high: panel.high[s][k + 1], low: panel.low[s][k + 1], close: panel.close[s][k + 1] };
      settlements[symbol] = [{ fundingTime: barClose, rate: panel.fundSum[s][k], markPrice: null }];
    });
    const { state: next, record } = rvStep(state, {
      track: 'taker',
      prevFillTime,
      fillTime: barClose,
      fillBars,
      settlements,
      targets: Object.fromEntries(targets),
    });
    out.push(record.equityAfter / prevEquity - 1);
    prevEquity = record.equityAfter;
    prevFillTime = barClose;
    state = next;
  }
  return out;
}
