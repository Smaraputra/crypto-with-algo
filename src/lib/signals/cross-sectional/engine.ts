/**
 * rv-v1: the frozen 8h cross-sectional relative value rule, as pure functions.
 *
 * The live desk and the research harness both call this file, so a live
 * decision and its research replay compute identical numbers. Nothing here
 * reads a clock, the network or the database: every input is an argument and a
 * missing input yields an explicit skip reason or a typed RvDataError, never a
 * substituted default.
 */
import { standardizeCrossSection, type FactorScores } from './factors';
import { constructBufferedPortfolio } from './portfolio';
import { BINANCE_FUTURES_MAKER_FEE, BINANCE_FUTURES_TAKER_FEE } from '@/lib/backtest/cost-model';

export const RV_V1 = {
  version: 'rv-v1',
  barMs: 8 * 60 * 60 * 1000,
  weights: { mom: 0.3, idio: 0.25, carry: 0.3, flow: 0.15 },
  momBars: 42, // return over 42 bars (needs 43 closes) and beta window of 42 returns
  flowBars: 43, // taker-buy share over the last 43 bars (the live value, pinned)
  legs: 2,
  buffer: 2,
  autoClampBuffer: true,
  betaNeutral: true,
  betaClamp: [0.1, 3.0],
  minUniverse: 5,
  winsorizeLimit: 3,
  startingEquity: 10_000,
  costs: { takerFee: BINANCE_FUTURES_TAKER_FEE, makerFee: BINANCE_FUTURES_MAKER_FEE, takerSlippageBps: 2 },
  makerWindowMs: 60 * 60 * 1000,
} as const;

/** The shape of a rule configuration, so a research variant can pass its own. */
export interface RvConfig {
  version: string;
  barMs: number;
  weights: RvWeights;
  momBars: number;
  flowBars: number;
  legs: number;
  buffer: number;
  autoClampBuffer: boolean;
  betaNeutral: boolean;
  betaClamp: readonly [number, number];
  minUniverse: number;
  winsorizeLimit: number;
  startingEquity: number;
  costs: { takerFee: number; makerFee: number; takerSlippageBps: number };
  makerWindowMs: number;
}

export interface RvWeights {
  mom?: number;
  idio?: number;
  carry?: number;
  flow?: number;
}

// ------------------------------------------------------------------ types

export interface RvBar {
  openTime: number;
  close: number;
  volume: number;
  takerBuyVolume: number | null;
}
export interface RvSettlement {
  fundingTime: number;
  rate: number;
  markPrice: number | null;
}
export interface RvSymbolInput {
  symbol: string;
  bars: RvBar[];
  lastSettlement: RvSettlement | null;
}
export type RvSkipReason =
  | 'bars_incomplete'
  | 'bars_not_contiguous'
  | 'carry_missing'
  | 'carry_stale'
  | 'flow_missing';

/**
 * A data failure the caller must handle by waiting and retrying. It is never
 * turned into a trade: a held leg whose score is missing is not an exit.
 */
export class RvDataError extends Error {
  constructor(
    public code:
      | 'btc_missing'
      | 'universe_too_small'
      | 'held_symbol_unscored'
      | 'beta_missing'
      | 'bad_input'
      | 'bad_config',
    message: string
  ) {
    super(message);
    this.name = 'RvDataError';
  }
}

export interface RvFactorRow {
  symbol: string;
  mom: number;
  idio: number;
  carry: number;
  flow: number;
  beta: number;
  zMom: number;
  zIdio: number;
  zCarry: number;
  zFlow: number;
}
export interface RvFactorResult {
  barTime: number;
  rows: RvFactorRow[];
  skipped: { symbol: string; reason: RvSkipReason }[];
}

// ---------------------------------------------------------------- factors

interface Scored {
  symbol: string;
  bars: RvBar[];
  mom: number;
  carry: number;
  flow: number;
}

function scoreSymbol(input: RvSymbolInput, barTime: number, cfg: RvConfig): Scored | RvSkipReason {
  const sorted = [...input.bars].sort((a, b) => a.openTime - b.openTime);
  const bars = sorted.slice(-cfg.flowBars);
  const valid = bars.every((b) => Number.isFinite(b.close) && b.close > 0);
  if (bars.length < cfg.flowBars || bars[bars.length - 1].openTime !== barTime || !valid) {
    return 'bars_incomplete';
  }
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].openTime - bars[i - 1].openTime !== cfg.barMs) return 'bars_not_contiguous';
  }

  const mom = bars[bars.length - 1].close / bars[bars.length - 1 - cfg.momBars].close - 1;

  const s = input.lastSettlement;
  if (!s) return 'carry_missing';
  const barClose = barTime + cfg.barMs;
  if (!(s.fundingTime > barClose - cfg.barMs && s.fundingTime <= barClose) || !Number.isFinite(s.rate)) {
    return 'carry_stale';
  }
  const carry = -s.rate;

  let buy = 0;
  let vol = 0;
  for (const b of bars) {
    if (
      b.takerBuyVolume === null ||
      !Number.isFinite(b.takerBuyVolume) ||
      !Number.isFinite(b.volume) ||
      b.volume < 0 ||
      b.takerBuyVolume < 0 ||
      b.takerBuyVolume > b.volume
    ) {
      return 'flow_missing';
    }
    buy += b.takerBuyVolume;
    vol += b.volume;
  }
  if (vol <= 0) return 'flow_missing';

  return { symbol: input.symbol, bars, mom, carry, flow: buy / vol - 0.5 };
}

function windowReturns(bars: RvBar[], momBars: number): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = bars.length - momBars; i < bars.length; i++) {
    out.set(bars[i].openTime, bars[i].close / bars[i - 1].close - 1);
  }
  return out;
}

/** Exported for tests: the aligned-pair beta used by rvFactors. */
export function rvBeta(rets: Map<number, number>, btc: Map<number, number>, cfg: RvConfig): number {
  const pairs: [number, number][] = [];
  for (const [t, r] of rets) {
    const b = btc.get(t);
    if (b === undefined) throw new RvDataError('bad_input', `BTC return missing at ${t}, so the beta pair cannot be aligned`);
    pairs.push([r, b]);
  }
  const n = pairs.length;
  const meanS = pairs.reduce((a, [r]) => a + r, 0) / n;
  const meanB = pairs.reduce((a, [, b]) => a + b, 0) / n;
  const varB = pairs.reduce((a, [, b]) => a + (b - meanB) ** 2, 0) / (n - 1);
  if (varB <= 1e-12) return 1.0;
  const cov = pairs.reduce((a, [r, b]) => a + (r - meanS) * (b - meanB), 0) / (n - 1);
  return Math.max(cfg.betaClamp[0], Math.min(cfg.betaClamp[1], cov / varB));
}

/**
 * Raw and standardised factors for the bar that OPENED at `barTime` (its close
 * is barTime + barMs). A symbol with unusable data is skipped with a reason
 * rather than scored on a default.
 */
export function rvFactors(inputs: RvSymbolInput[], barTime: number, cfg: RvConfig = RV_V1): RvFactorResult {
  if (cfg.momBars + 1 > cfg.flowBars) {
    throw new RvDataError('bad_config', `momBars ${cfg.momBars} needs ${cfg.momBars + 1} bars but flowBars is ${cfg.flowBars}`);
  }
  const scored: Scored[] = [];
  const skipped: RvFactorResult['skipped'] = [];
  for (const input of inputs) {
    const res = scoreSymbol(input, barTime, cfg);
    if (typeof res === 'string') skipped.push({ symbol: input.symbol, reason: res });
    else scored.push(res);
  }

  const btc = scored.find((s) => s.symbol === 'BTCUSDT');
  if (!btc) throw new RvDataError('btc_missing', 'BTCUSDT has no usable data, so beta has no anchor');
  if (scored.length < cfg.minUniverse) {
    throw new RvDataError(
      'universe_too_small',
      `${scored.length} symbols usable, minimum ${cfg.minUniverse} required`
    );
  }

  const btcRets = windowReturns(btc.bars, cfg.momBars);
  const partial = scored.map((s) => {
    const beta = s.symbol === 'BTCUSDT' ? 1.0 : rvBeta(windowReturns(s.bars, cfg.momBars), btcRets, cfg);
    return { ...s, beta, idio: s.mom - beta * btc.mom };
  });

  const zMom = standardizeCrossSection(partial.map((p) => p.mom), cfg.winsorizeLimit);
  const zIdio = standardizeCrossSection(partial.map((p) => p.idio), cfg.winsorizeLimit);
  const zCarry = standardizeCrossSection(partial.map((p) => p.carry), cfg.winsorizeLimit);
  const zFlow = standardizeCrossSection(partial.map((p) => p.flow), cfg.winsorizeLimit);

  const rows: RvFactorRow[] = partial.map((p, i) => ({
    symbol: p.symbol,
    mom: p.mom,
    idio: p.idio,
    carry: p.carry,
    flow: p.flow,
    beta: p.beta,
    zMom: zMom[i],
    zIdio: zIdio[i],
    zCarry: zCarry[i],
    zFlow: zFlow[i],
  }));
  return { barTime, rows, skipped };
}

// -------------------------------------------------------------- composite

export interface RvRanked {
  symbol: string;
  compositeZ: number;
  rank: number;
}

/** Weighted z-score sum, rank 1 = strongest long. A weight left out counts as 0. */
export function rvComposite(rows: RvFactorRow[], weights: RvWeights): RvRanked[] {
  const scored = rows.map((r) => ({
    symbol: r.symbol,
    compositeZ:
      (weights.mom ?? 0) * r.zMom +
      (weights.idio ?? 0) * r.zIdio +
      (weights.carry ?? 0) * r.zCarry +
      (weights.flow ?? 0) * r.zFlow,
    rank: 0,
  }));
  scored.sort((a, b) => b.compositeZ - a.compositeZ || a.symbol.localeCompare(b.symbol));
  scored.forEach((s, i) => {
    s.rank = i + 1;
  });
  return scored;
}

// ---------------------------------------------------------------- targets

export interface RvCell {
  legs: number;
  buffer: number;
  betaNeutral: boolean;
  autoClampBuffer: boolean;
}

const RV_V1_CELL: RvCell = {
  legs: RV_V1.legs,
  buffer: RV_V1.buffer,
  betaNeutral: RV_V1.betaNeutral,
  autoClampBuffer: RV_V1.autoClampBuffer,
};

/**
 * Target weights from a ranking and the legs currently held. A held symbol
 * missing from the ranking throws: a data failure must never become an exit.
 */
export function rvTargets(
  ranked: RvRanked[],
  held: Map<string, 1 | -1>,
  betas: Map<string, number>,
  cell: RvCell = RV_V1_CELL
): Map<string, number> {
  const rankOf = new Map(ranked.map((r) => [r.symbol, r.rank]));
  for (const symbol of held.keys()) {
    if (!rankOf.has(symbol)) {
      throw new RvDataError('held_symbol_unscored', `${symbol} is held but missing from the ranking`);
    }
  }

  if (cell.betaNeutral) {
    for (const r of ranked) {
      if (!Number.isFinite(betas.get(r.symbol))) {
        throw new RvDataError('beta_missing', `${r.symbol} has no finite beta for beta-neutral sizing`);
      }
    }
  }

  // portfolio.ts trims retained legs in insertion order, so insert best-ranked first
  const longs = [...held].filter(([, side]) => side > 0).sort(([a], [b]) => rankOf.get(a)! - rankOf.get(b)!);
  const shorts = [...held].filter(([, side]) => side < 0).sort(([a], [b]) => rankOf.get(b)! - rankOf.get(a)!);
  const currentPositions = new Map<string, number>([...longs, ...shorts]);

  // portfolio.ts reads only symbol and rank from each score
  const alloc = constructBufferedPortfolio(currentPositions, ranked as FactorScores[], {
    legs: cell.legs,
    buffer: cell.buffer,
    autoClampBuffer: cell.autoClampBuffer,
    ...(cell.betaNeutral ? { betas } : {}),
  });
  return alloc.positions;
}

// ------------------------------------------------------------- accounting

export interface RvPosition {
  qty: number;
  avgEntry: number;
  lastMark: number;
}
/** Plain object so it stores as JSON. */
export interface RvTrackState {
  cash: number;
  positions: Record<string, RvPosition>;
}
/** The first 1h perp bar opening at fillTime. */
export interface RvFillBar {
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface RvStepInput {
  track: 'taker' | 'maker';
  prevFillTime: number | null; // null on the first step
  fillTime: number; // = barClose of the signal bar = open of the next bar
  fillBars: Record<string, RvFillBar | null>;
  settlements: Record<string, RvSettlement[]>; // every settlement with prevFillTime < fundingTime <= fillTime
  targets: Record<string, number>; // weights from rvTargets, absent = 0
}
export interface RvFill {
  symbol: string;
  deltaQty: number;
  price: number;
  fee: number;
  kind: 'taker' | 'maker' | 'taker_fallback';
  realizedPnl: number;
}
export interface RvStepRecord {
  equityBefore: number;
  equityAfter: number;
  funding: { symbol: string; fundingTime: number; amount: number; markPrice: number }[];
  fills: RvFill[];
  fees: number;
  realizedPnl: number;
  unrealizedPnl: number;
  stale: string[];
  skippedEntries: string[];
  /** Set when the step sized and traded nothing because equity was not positive. */
  halted: 'equity_non_positive' | null;
  /** Notional over equity after the step; null when equity is not positive. */
  gross: number | null;
}

const QTY_EPS = 1e-12;

export function rvInitialState(cfg: RvConfig = RV_V1): RvTrackState {
  return { cash: cfg.startingEquity, positions: {} };
}

function markedEquity(cash: number, positions: Record<string, RvPosition>): number {
  return Object.values(positions).reduce((sum, p) => sum + p.qty * p.lastMark, 0) + cash;
}

/**
 * One rebalance at fillTime: settle funding on the legs held, mark them at the
 * fill-bar open, size every target from that one equity snapshot, trade the
 * difference and report. Pure and deterministic: symbols are processed in
 * alphabetical order and equity is never clamped.
 */
export function rvStep(
  state: RvTrackState,
  input: RvStepInput,
  cfg: RvConfig = RV_V1
): { state: RvTrackState; record: RvStepRecord } {
  const positions: Record<string, RvPosition> = {};
  for (const [sym, p] of Object.entries(state.positions)) {
    if (p.qty !== 0) positions[sym] = { ...p };
  }
  let cash = state.cash;
  const record: RvStepRecord = {
    equityBefore: 0,
    equityAfter: 0,
    funding: [],
    fills: [],
    fees: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    stale: [],
    skippedEntries: [],
    halted: null,
    gross: null,
  };

  if (input.prevFillTime === null && Object.keys(positions).length > 0) {
    throw new RvDataError('bad_input', 'prevFillTime is null but the state holds positions');
  }
  for (const [sym, bar] of Object.entries(input.fillBars)) {
    if (bar && ![bar.open, bar.high, bar.low, bar.close].every((v) => Number.isFinite(v) && v > 0)) {
      throw new RvDataError('bad_input', `fill bar for ${sym} has a non-finite or non-positive price`);
    }
  }

  // 1. Funding on the quantity held going into the step, one entry per settlement crossed
  for (const sym of Object.keys(positions).sort()) {
    const pos = positions[sym];
    const crossed = (input.settlements[sym] ?? [])
      .filter((s) => (input.prevFillTime === null || s.fundingTime > input.prevFillTime) && s.fundingTime <= input.fillTime)
      .sort((a, b) => a.fundingTime - b.fundingTime);
    for (const s of crossed) {
      if (!Number.isFinite(s.rate)) {
        throw new RvDataError('bad_input', `settlement for ${sym} at ${s.fundingTime} has a non-finite rate`);
      }
      const markPrice = s.markPrice !== null && Number.isFinite(s.markPrice) ? s.markPrice : pos.lastMark;
      const amount = -pos.qty * markPrice * s.rate;
      cash += amount;
      record.funding.push({ symbol: sym, fundingTime: s.fundingTime, amount, markPrice });
    }
  }

  // 2. Mark held legs at the fill-bar open
  const refOf = (sym: string): number | null => {
    const bar = input.fillBars[sym];
    return bar && Number.isFinite(bar.open) && bar.open > 0 ? bar.open : null;
  };
  for (const sym of Object.keys(positions).sort()) {
    const ref = refOf(sym);
    if (ref === null) record.stale.push(sym);
    else positions[sym].lastMark = ref;
  }
  const equityBefore = markedEquity(cash, positions);
  record.equityBefore = equityBefore;
  // Sizing from non-positive equity would invert every target, so the step only marks
  const halted = !(equityBefore > 0);
  if (halted) record.halted = 'equity_non_positive';

  // 3-4. Size every symbol from the one snapshot, then trade the difference
  const symbols = [...new Set([...Object.keys(positions), ...Object.keys(input.targets)])].sort();
  const slip = cfg.costs.takerSlippageBps / 1e4;
  for (const sym of halted ? [] : symbols) {
    const pos = positions[sym];
    const qty = pos?.qty ?? 0;
    const weight = input.targets[sym] ?? 0;
    const ref = refOf(sym);
    if (ref === null) {
      if (qty === 0 && weight !== 0) record.skippedEntries.push(sym);
      continue;
    }
    const targetQty = (weight * equityBefore) / ref;
    const delta = targetQty - qty;
    if (Math.abs(delta) <= QTY_EPS) {
      if (pos) pos.lastMark = ref;
      continue;
    }

    const bar = input.fillBars[sym]!;
    const side = Math.sign(delta);
    let price: number;
    let feeRate: number;
    let kind: RvFill['kind'];
    if (input.track === 'maker') {
      const filled = (delta > 0 && bar.low < ref) || (delta < 0 && bar.high > ref);
      if (filled) {
        price = ref;
        feeRate = cfg.costs.makerFee;
        kind = 'maker';
      } else {
        price = bar.close * (1 + side * slip);
        feeRate = cfg.costs.takerFee;
        kind = 'taker_fallback';
      }
    } else {
      price = ref * (1 + side * slip);
      feeRate = cfg.costs.takerFee;
      kind = 'taker';
    }
    const fee = Math.abs(delta) * price * feeRate;
    cash -= delta * price;
    cash -= fee;

    let realizedPnl = 0;
    let avgEntry: number;
    if (qty === 0) {
      avgEntry = price;
    } else if (Math.sign(qty) === side) {
      avgEntry = (Math.abs(qty) * pos.avgEntry + Math.abs(delta) * price) / (Math.abs(qty) + Math.abs(delta));
    } else {
      const closed = Math.min(Math.abs(delta), Math.abs(qty));
      realizedPnl = closed * (price - pos.avgEntry) * Math.sign(qty);
      avgEntry = Math.abs(delta) > Math.abs(qty) ? price : pos.avgEntry;
    }

    if (Math.abs(targetQty) <= QTY_EPS) delete positions[sym];
    else positions[sym] = { qty: targetQty, avgEntry, lastMark: ref };

    record.fills.push({ symbol: sym, deltaQty: delta, price, fee, kind, realizedPnl });
    record.fees += fee;
    record.realizedPnl += realizedPnl;
  }

  // 5. Close-out numbers; equity is never clamped
  record.equityAfter = markedEquity(cash, positions);
  let notional = 0;
  for (const p of Object.values(positions)) {
    record.unrealizedPnl += p.qty * (p.lastMark - p.avgEntry);
    notional += Math.abs(p.qty * p.lastMark);
  }
  record.gross = record.equityAfter > 0 ? notional / record.equityAfter : null;

  return { state: { cash, positions }, record };
}
