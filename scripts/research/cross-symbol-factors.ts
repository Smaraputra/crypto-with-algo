/**
 * Factors that need more than one symbol's matrix: computed after every
 * symbol has loaded, appended to each matrix in place. computeFactorMatrix is
 * per symbol and cannot see BTC or the market mean, which is why these live
 * here rather than in factors.ts.
 *
 * `raw.btcLeadLag`: BTC's one-bar return minus the equal-weight one-bar
 * return across the symbols with a finite reading at that timestamp, read
 * for every non-BTC symbol; NaN for BTC, where BTC has no bar, and where
 * fewer than `minSymbols` symbols have a finite return. Joined on timestamp,
 * never on position. Pre-registered POSITIVE at h1 to h4 for alts (delayed
 * reaction to BTC); see the Phase B block in factors.ts.
 */
import type { FactorMatrix } from './factors';

export const BTC_SYMBOL = 'BTCUSDT';
export const CROSS_SYMBOL_NAMES = ['raw.btcLeadLag'] as const;

function ret1Of(matrix: FactorMatrix): Float64Array {
  const idx = matrix.names.indexOf('raw.ret1');
  if (idx === -1) throw new Error('appendCrossSymbolFactors: matrix has no raw.ret1 column');
  return matrix.values[idx];
}

export function appendCrossSymbolFactors(
  perSymbol: ReadonlyArray<{ symbol: string; matrix: FactorMatrix }>,
  minSymbols: number
): void {
  if (perSymbol.length === 0) return;
  if (perSymbol.every((d) => d.matrix.names.includes('raw.btcLeadLag'))) return;

  const market = new Map<number, { sum: number; count: number }>();
  for (const d of perSymbol) {
    const r = ret1Of(d.matrix);
    d.matrix.timestamps.forEach((t, i) => {
      const v = r[i];
      if (!Number.isFinite(v)) return;
      const entry = market.get(t);
      if (entry) {
        entry.sum += v;
        entry.count++;
      } else {
        market.set(t, { sum: v, count: 1 });
      }
    });
  }

  const btc = perSymbol.find((d) => d.symbol === BTC_SYMBOL);
  const btcByTime = new Map<number, number>();
  if (btc) {
    const r = ret1Of(btc.matrix);
    btc.matrix.timestamps.forEach((t, i) => {
      if (Number.isFinite(r[i])) btcByTime.set(t, r[i]);
    });
  }

  for (const d of perSymbol) {
    if (d.matrix.names.includes('raw.btcLeadLag')) continue;
    const ts = d.matrix.timestamps;
    const col = new Float64Array(ts.length).fill(NaN);
    if (d.symbol !== BTC_SYMBOL && btc) {
      for (let i = 0; i < ts.length; i++) {
        const b = btcByTime.get(ts[i]);
        const m = market.get(ts[i]);
        if (b !== undefined && m && m.count >= minSymbols) col[i] = b - m.sum / m.count;
      }
    }
    d.matrix.names.push('raw.btcLeadLag');
    d.matrix.categories.push('raw');
    d.matrix.values.push(col);
  }
}
