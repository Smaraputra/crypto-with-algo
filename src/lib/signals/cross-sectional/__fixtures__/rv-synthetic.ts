import type { OHLCV } from '@/types/market';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import type { RvBar, RvSymbolInput } from '../engine';

const BAR_MS = 8 * 60 * 60 * 1000;
export const SYNTHETIC_BAR_TIME = 1_789_948_800_000; // 2026-09-21T00:00:00Z, an 8h boundary
const N_BARS = 43;

/** Deterministic pseudo-random sequence in [0, 1), so the golden fixture reproduces. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export interface SyntheticUniverse {
  barTime: number;
  inputs: RvSymbolInput[];
  candles: Map<string, OHLCV[]>;
  funding: Map<string, number>;
}

/**
 * Ten symbols with distinct betas, drifts, taker-buy shares and funding, built
 * from non-constant returns so beta, flow and carry all differ across the
 * cross-section. The same bars feed the pure engine (RvBar) and the legacy
 * generator (OHLCV) so the two can be compared field for field.
 */
export function buildSyntheticUniverse(): SyntheticUniverse {
  const rand = lcg(20260921);
  const btcRets = Array.from({ length: N_BARS - 1 }, () => (rand() - 0.5) * 0.04);
  const inputs: RvSymbolInput[] = [];
  const candles = new Map<string, OHLCV[]>();
  const funding = new Map<string, number>();

  SIGNAL_SYMBOLS.forEach((symbol, k) => {
    const beta = symbol === 'BTCUSDT' ? 1 : 0.5 + k * 0.2;
    const drift = (k - 4.5) * 0.0004;
    const takerShare = 0.44 + rand() * 0.12;
    let close = 100 * (k + 1);
    const bars: RvBar[] = [];
    const ohlcv: OHLCV[] = [];
    for (let i = 0; i < N_BARS; i++) {
      if (i > 0) {
        const idio = symbol === 'BTCUSDT' ? 0 : (rand() - 0.5) * 0.02;
        close = close * (1 + beta * btcRets[i - 1] + idio + drift);
      }
      const openTime = SYNTHETIC_BAR_TIME - (N_BARS - 1 - i) * BAR_MS;
      const volume = 1000 + Math.floor(rand() * 500);
      const takerBuyVolume = volume * (takerShare + (rand() - 0.5) * 0.02);
      bars.push({ openTime, close, volume, takerBuyVolume });
      ohlcv.push({
        timestamp: openTime,
        open: close,
        high: close * 1.01,
        low: close * 0.99,
        close,
        volume,
        takerBuyVolume,
      });
    }
    const rate = (rand() - 0.5) * 0.0006;
    funding.set(symbol, rate);
    inputs.push({
      symbol,
      bars,
      lastSettlement: { fundingTime: SYNTHETIC_BAR_TIME + BAR_MS, rate, markPrice: close },
    });
    candles.set(symbol, ohlcv);
  });

  return { barTime: SYNTHETIC_BAR_TIME, inputs, candles, funding };
}
