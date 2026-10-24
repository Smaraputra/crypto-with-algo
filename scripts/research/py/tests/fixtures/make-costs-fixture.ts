import { writeFileSync } from 'node:fs';
import {
  BINANCE_FUTURES_MAKER_FEE,
  BINANCE_FUTURES_TAKER_FEE,
  STUDY_SLIPPAGE_BPS,
  FEE_PROFILES,
  FEE_PROFILE_NAMES,
  defaultCostPercent,
  studyCostConfig,
  applySlippage,
  resolveFeeProfile,
} from '../../../../../src/lib/backtest/cost-model';
import { FUNDING_INTERVAL_MS, fundingCrossings, fundingPnl } from '../../../../../src/lib/backtest/funding';
import { fundingSumsFor } from '../../../../../scripts/research/strategy-walk-forward';

const intervals = Object.keys(STUDY_SLIPPAGE_BPS);
const symbols = [undefined, 'BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const H = 3_600_000;
const base = Date.UTC(2024, 0, 1);

const costCases = [];
for (const interval of intervals)
  for (const profile of FEE_PROFILE_NAMES)
    for (const symbol of symbols) {
      const resolved = resolveFeeProfile(profile, symbol);
      costCases.push({
        interval, profile, symbol: symbol ?? null,
        resolvedProfile: resolved.name,
        defaultCostPercent: defaultCostPercent(interval, { profile, symbol }),
        studyCostConfig: studyCostConfig(interval, { profile, symbol }),
      });
    }

const slippageCases = [];
for (const price of [1, 0.123456, 98765.4321])
  for (const direction of ['buy', 'sell'] as const)
    for (const bps of [0, 2, 3, 5, 10, 17.5])
      slippageCases.push({ price, direction, bps, result: applySlippage(price, direction, bps) });

const crossingCases = [];
const points = [base - 1, base, base + 1, base + 8 * H - 1, base + 8 * H, base + 8 * H + 1, base + 23 * H, base + 24 * H, base + 72 * H + 5];
for (const a of points) for (const b of points) crossingCases.push({ prevCloseTime: a, closeTime: b, crossings: fundingCrossings(a, b) });

const pnlCases = [];
for (const notional of [1, 1000.5]) for (const rate of [0.0001, -0.00025, 0]) for (const side of ['long', 'short'] as const) for (const crossings of [0, 1, 3])
  pnlCases.push({ notional, fundingRate: rate, side, crossings, pnl: fundingPnl(notional, rate, side, crossings) });

// Settlement-time funding per bar: (open, open + interval]. Irregular settlement times on purpose
// (8h grid, then a 4h-interval stretch, then times a few ms off the hour), plus one duplicate time.
const settlements = [
  { t: base, rate: 0.0001 }, { t: base + 8 * H, rate: 0.0002 }, { t: base + 16 * H, rate: -0.0001 },
  { t: base + 20 * H, rate: 0.00005 }, { t: base + 24 * H, rate: 0.0003 }, { t: base + 28 * H + 7, rate: -0.0002 },
  { t: base + 32 * H, rate: 0.0001 }, { t: base + 32 * H, rate: 0.00002 }, { t: base + 40 * H - 3, rate: 0.0004 },
];
const sumsCases = [];
for (const [intervalMs, label] of [[H, '1h'], [4 * H, '4h'], [24 * H, '1d']] as const) {
  const candles = [];
  for (let t = base - 2 * intervalMs; t < base + 48 * H; t += intervalMs) candles.push({ timestamp: t, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  const sums = Array.from(fundingSumsFor(candles as never, intervalMs, settlements));
  sumsCases.push({ interval: label, intervalMs, opens: candles.map((c) => c.timestamp), sums });
}

writeFileSync(process.argv[2], JSON.stringify({
  source: 'src/lib/backtest/cost-model.ts, src/lib/backtest/funding.ts, scripts/research/strategy-walk-forward.ts fundingSumsFor',
  constants: { BINANCE_FUTURES_MAKER_FEE, BINANCE_FUTURES_TAKER_FEE, STUDY_SLIPPAGE_BPS, FUNDING_INTERVAL_MS, FEE_PROFILES },
  costCases, slippageCases, crossingCases, pnlCases, settlements, sumsCases,
}, null, 1) + '\n');
console.log('cases', costCases.length, slippageCases.length, crossingCases.length, pnlCases.length, sumsCases.map((c) => c.sums.length));
process.exit(0);
