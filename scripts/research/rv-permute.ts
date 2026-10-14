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

/**
 * One permutation of the whole panel. The returned panel is new and `panel` is not modified. Timestamps and
 * symbols are unchanged.
 */
export function permutePanel(panel: RvPanel, startIndex: number, random: () => number): RvPanel {
  const n = panel.t.length;
  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= n) {
    throw new Error(`startIndex must be an integer in [0, ${n - 1}], got ${startIndex}`);
  }
  const permIndex = startIndex + 1;
  const permN = n - permIndex;
  const perm1 = permutationIndex(permN, random); // intrabar tuple
  const perm2 = permutationIndex(permN, random); // gap

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
