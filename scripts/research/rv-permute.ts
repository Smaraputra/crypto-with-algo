/**
 * The bar permutation of the rv-v1 re-validation (header STEP 2 and STEP 4), a port of
 * neurotrader888/mcpt bar_permute.py `get_permutation` for a list of markets.
 *
 * Mapping to bar_permute.py:
 * - `perm_index = start_index + 1`, `perm_n = n_bars - perm_index`: identical. Bars 0..startIndex stay
 *   real and permutation begins at startIndex + 1, that bar's gap included (step 2: startIndex 0, step 4:
 *   startIndex 1,094).
 * - `relative_open` (log open minus previous log close) and `relative_high/low/close` (log price minus log
 *   open) are computed per market over the permuted range: identical.
 * - `perm1` permutes the intrabar values and is drawn first, `perm2` permutes the gaps and is drawn second.
 *   Both are drawn once and applied to every market, so the cross-section moves together: identical.
 * - Prices are rebuilt by compounding from the real log close of bar startIndex: identical.
 * Differences, each required by the header or the panel:
 * - The intrabar tuple also carries volume, taker-buy volume, the per-bar funding sum and fundLast, so a
 *   permuted funding value is stamped at the close of the bar it lands on (header STEP 2).
 * - Bars 0..startIndex are copied as stored, not passed through exp(log(x)), so they stay bitwise real.
 * - The random source is the seeded mulberry32 stream with a Fisher-Yates shuffle, not numpy's.
 */
import type { RvPanel } from './rv-panel';

/** Fisher-Yates over 0..n-1 (the loop of broad-harness.ts permuteReturns), driven by `random`. */
export function permutationIndex(n: number, random: () => number): number[] {
  if (!Number.isInteger(n) || n < 0) throw new Error(`permutationIndex needs a non-negative integer, got ${n}`);
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let j = n - 1; j > 0; j--) {
    const k = Math.floor(random() * (j + 1));
    const tmp = idx[j];
    idx[j] = idx[k];
    idx[k] = tmp;
  }
  return idx;
}

/** Throws unless `perm` is a permutation of 0..n-1. */
function assertPermutation(perm: readonly number[], n: number, name: string): void {
  const seen = new Uint8Array(n);
  const ok = perm.length === n && perm.every((v) => Number.isInteger(v) && v >= 0 && v < n && seen[v]++ === 0);
  if (!ok) throw new Error(`${name} must be a permutation of 0..${n - 1}`);
}

/**
 * The two shared indices of one permutation, drawn in bar_permute's order: perm1 (intrabar tuple) first,
 * perm2 (gap) second. `permN` is the number of permuted bars, n - startIndex - 1.
 */
export function drawBarPermutation(permN: number, random: () => number): { perm1: number[]; perm2: number[] } {
  const perm1 = permutationIndex(permN, random);
  const perm2 = permutationIndex(permN, random);
  return { perm1, perm2 };
}

/**
 * Applies given indices to the whole panel: permuted bar startIndex + 1 + k takes the gap of bar
 * startIndex + 1 + perm2[k] and the intrabar tuple (high, low and close over open, volume, taker-buy
 * volume, fundSum, fundLast) of bar startIndex + 1 + perm1[k], compounding from the real close of bar
 * startIndex. The returned panel is new and `panel` is not modified. Timestamps and symbols are unchanged.
 */
export function applyBarPermutation(panel: RvPanel, startIndex: number, perm1: readonly number[], perm2: readonly number[]): RvPanel {
  const n = panel.t.length;
  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= n) {
    throw new Error(`startIndex must be an integer in [0, ${n - 1}], got ${startIndex}`);
  }
  const permIndex = startIndex + 1;
  const permN = n - permIndex;
  assertPermutation(perm1, permN, 'perm1');
  assertPermutation(perm2, permN, 'perm2');

  const out: RvPanel = {
    symbols: [...panel.symbols],
    t: [...panel.t],
    open: [],
    high: [],
    low: [],
    close: [],
    volume: [],
    tbv: [],
    fundSum: [],
    fundLast: [],
  };

  panel.symbols.forEach((_, s) => {
    const open = panel.open[s].slice(0, permIndex);
    const high = panel.high[s].slice(0, permIndex);
    const low = panel.low[s].slice(0, permIndex);
    const close = panel.close[s].slice(0, permIndex);
    const volume = panel.volume[s].slice(0, permIndex);
    const tbv = panel.tbv[s].slice(0, permIndex);
    const fundSum = panel.fundSum[s].slice(0, permIndex);
    const fundLast = panel.fundLast[s].slice(0, permIndex);

    const rO = new Float64Array(permN);
    const rH = new Float64Array(permN);
    const rL = new Float64Array(permN);
    const rC = new Float64Array(permN);
    for (let k = 0; k < permN; k++) {
      const i = permIndex + k;
      const logOpen = Math.log(panel.open[s][i]);
      rO[k] = logOpen - Math.log(panel.close[s][i - 1]);
      rH[k] = Math.log(panel.high[s][i]) - logOpen;
      rL[k] = Math.log(panel.low[s][i]) - logOpen;
      rC[k] = Math.log(panel.close[s][i]) - logOpen;
    }

    let prevLogClose = Math.log(panel.close[s][startIndex]);
    for (let k = 0; k < permN; k++) {
      const a = perm1[k];
      const src = permIndex + a;
      const logOpen = prevLogClose + rO[perm2[k]];
      open.push(Math.exp(logOpen));
      high.push(Math.exp(logOpen + rH[a]));
      low.push(Math.exp(logOpen + rL[a]));
      close.push(Math.exp(logOpen + rC[a]));
      volume.push(panel.volume[s][src]);
      tbv.push(panel.tbv[s][src]);
      fundSum.push(panel.fundSum[s][src]);
      fundLast.push(panel.fundLast[s][src]);
      prevLogClose = logOpen + rC[a];
    }

    out.open.push(open);
    out.high.push(high);
    out.low.push(low);
    out.close.push(close);
    out.volume.push(volume);
    out.tbv.push(tbv);
    out.fundSum.push(fundSum);
    out.fundLast.push(fundLast);
  });
  return out;
}

/** One permutation of the whole panel: drawBarPermutation, then applyBarPermutation. */
export function permutePanel(panel: RvPanel, startIndex: number, random: () => number): RvPanel {
  const n = panel.t.length;
  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= n) {
    throw new Error(`startIndex must be an integer in [0, ${n - 1}], got ${startIndex}`);
  }
  const { perm1, perm2 } = drawBarPermutation(n - startIndex - 1, random);
  return applyBarPermutation(panel, startIndex, perm1, perm2);
}
