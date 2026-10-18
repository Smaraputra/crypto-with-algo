import { writeFileSync } from 'fs';
import type { CandleRow } from './dataset-format';
import { loadCandles, loadManifest, verifyManifest } from './load-dataset';
import { NV1_SYMBOLS } from './nv1-c1-scores';
import {
  NV1_SEGMENTS,
  buildTrades,
  drawFraction,
  nullN,
  quantile7,
  sumNetTrades,
  type CoinSeries,
  type TradeOptions,
} from './nv1-core';
import { createSeededRandom } from '../../src/lib/stats/seeded-random';

export const DAY_MS = 86_400_000;

export const NV1_C3 = {
  ks: [0, 1, 2, 3],
  bins: 200,                 // keep NUM_BINS as an alias equal to this
  valueAreaShare: 0.7,
  minBarsPerDay: 90,
  threshold: 0.25,
  plateauThresholds: [0.15, 0.35],
  hold: 1,
  costPct: 0.14,
  nullDraws: 1000,
  nullSeed: 20261300,
  minShiftBars: 30,
  nullQuantile: 0.9,
} as const;

export const NUM_BINS = NV1_C3.bins;

export interface ValueArea {
  poc: number;
  vah: number;
  val: number;
  m: number;
  width: number;
  t?: number;
}

/**
 * Computes the Value Area for a single UTC day from its spot 15m bars.
 * - Requires at least 90 bars (out of 96 expected); returns null otherwise.
 * - 200 linear bins on [dayLow, dayHigh]; returns null if dayLow == dayHigh.
 * - Each bar's volume is allocated in proportion to overlap with each bin.
 *   A bar with high == low puts all volume into the bin containing its close.
 * - POC is the bin with maximum volume; ties broken by nearest to day's last close, then lower bin.
 * - Value area grows from POC one bin at a time, adding the heavier neighbor (ties: above),
 *   until included volume reaches at least 70% of total day volume.
 * - VAH = upper edge of top included bin, VAL = lower edge of bottom included bin,
 *   m = (VAH + VAL) / 2, width = VAH - VAL, poc = price at POC bin center.
 */
export function valueArea(
  bars15m: Array<{ l: number; h: number; c: number; v: number }>
): ValueArea | null {
  if (bars15m.length < NV1_C3.minBarsPerDay) {
    return null;
  }

  let dayLow = Number.POSITIVE_INFINITY;
  let dayHigh = Number.NEGATIVE_INFINITY;
  let totalVolume = 0;

  for (let i = 0; i < bars15m.length; i++) {
    const bar = bars15m[i];
    if (bar.l < dayLow) dayLow = bar.l;
    if (bar.h > dayHigh) dayHigh = bar.h;
    if (bar.v > 0) totalVolume += bar.v;
  }

  if (!Number.isFinite(dayLow) || !Number.isFinite(dayHigh) || dayHigh <= dayLow || totalVolume <= 0) {
    return null;
  }

  const binWidth = (dayHigh - dayLow) / NUM_BINS;
  const binVolume = new Float64Array(NUM_BINS);

  for (let i = 0; i < bars15m.length; i++) {
    const bar = bars15m[i];
    const vol = bar.v;
    if (vol <= 0) continue;

    if (bar.h === bar.l) {
      let b = Math.floor((bar.c - dayLow) / binWidth);
      if (b < 0) b = 0;
      if (b >= NUM_BINS) b = NUM_BINS - 1;
      binVolume[b] += vol;
    } else {
      const barLen = bar.h - bar.l;
      const startBin = Math.max(0, Math.min(NUM_BINS - 1, Math.floor((bar.l - dayLow) / binWidth)));
      const endBin = Math.max(0, Math.min(NUM_BINS - 1, Math.floor((bar.h - dayLow) / binWidth)));

      for (let b = startBin; b <= endBin; b++) {
        const bLow = b === 0 ? dayLow : dayLow + b * binWidth;
        const bHigh = b === NUM_BINS - 1 ? dayHigh : dayLow + (b + 1) * binWidth;
        const overlap = Math.max(0, Math.min(bar.h, bHigh) - Math.max(bar.l, bLow));
        if (overlap > 0) {
          binVolume[b] += vol * (overlap / barLen);
        }
      }
    }
  }

  // POC selection: maximum volume, ties broken by nearest to day's last close, then lower bin
  const lastClose = bars15m[bars15m.length - 1].c;
  let pocBin = 0;
  let bestVol = -1;
  let bestDist = Number.POSITIVE_INFINITY;

  for (let b = 0; b < NUM_BINS; b++) {
    const vol = binVolume[b];
    const bCenter = dayLow + (b + 0.5) * binWidth;
    const dist = Math.abs(bCenter - lastClose);

    if (vol > bestVol + 1e-12) {
      bestVol = vol;
      bestDist = dist;
      pocBin = b;
    } else if (Math.abs(vol - bestVol) <= 1e-12) {
      if (dist < bestDist - 1e-12) {
        bestDist = dist;
        pocBin = b;
      }
      // If dist is also tied, lower bin is preserved (since b iterates ascendingly)
    }
  }

  // Value area expansion from POC
  const targetVolume = NV1_C3.valueAreaShare * totalVolume;
  let lowBin = pocBin;
  let highBin = pocBin;
  let includedVolume = binVolume[pocBin];

  while (includedVolume < targetVolume - 1e-12 && (lowBin > 0 || highBin < NUM_BINS - 1)) {
    const nextAbove = highBin + 1;
    const nextBelow = lowBin - 1;
    const hasAbove = nextAbove < NUM_BINS;
    const hasBelow = nextBelow >= 0;

    if (hasAbove && hasBelow) {
      const volAbove = binVolume[nextAbove];
      const volBelow = binVolume[nextBelow];
      // Ties go above
      if (volAbove >= volBelow - 1e-12) {
        highBin = nextAbove;
        includedVolume += volAbove;
      } else {
        lowBin = nextBelow;
        includedVolume += volBelow;
      }
    } else if (hasAbove) {
      highBin = nextAbove;
      includedVolume += binVolume[nextAbove];
    } else if (hasBelow) {
      lowBin = nextBelow;
      includedVolume += binVolume[nextBelow];
    }
  }

  const vah = highBin === NUM_BINS - 1 ? dayHigh : dayLow + (highBin + 1) * binWidth;
  const val = lowBin === 0 ? dayLow : dayLow + lowBin * binWidth;
  const m = (vah + val) / 2;
  const width = vah - val;
  const poc = dayLow + (pocBin + 0.5) * binWidth;

  return { poc, vah, val, m, width };
}

export type ValueAreaInput =
  | Array<{ t?: number; m: number; width: number } | null>
  | (ValueArea | null)[]
  | Map<number, ValueArea | null>;

/**
 * Computes daily directional signals from a sequence or map of daily value areas.
 * Signal for day D is known at 00:00 UTC from D-1 and D-2:
 * +1 if m(D-1) - m(D-2) > threshold * width(D-2)
 * -1 if m(D-1) - m(D-2) < -threshold * width(D-2)
 * 0 otherwise (and 0 when either day lacks a value area).
 */
export function dailySignals(
  valueAreas: ValueAreaInput,
  threshold: number = NV1_C3.threshold
): number[] {
  if (valueAreas instanceof Map) {
    const sortedKeys = Array.from(valueAreas.keys()).sort((a, b) => a - b);
    const result: number[] = new Array(sortedKeys.length);
    for (let i = 0; i < sortedKeys.length; i++) {
      const dayT = sortedKeys[i];
      const va1 = valueAreas.get(dayT - DAY_MS);
      const va2 = valueAreas.get(dayT - 2 * DAY_MS);
      if (!va1 || !va2) {
        result[i] = 0;
      } else {
        const diff = va1.m - va2.m;
        const cutoff = threshold * va2.width;
        if (diff > cutoff) {
          result[i] = 1;
        } else if (diff < -cutoff) {
          result[i] = -1;
        } else {
          result[i] = 0;
        }
      }
    }
    return result;
  }

  const arr = valueAreas;
  const n = arr.length;
  const result: number[] = new Array(n);

  // Check if array elements carry timestamp t
  const hasTimestamps = n > 0 && arr.some((item) => item !== null && typeof item.t === 'number');

  if (hasTimestamps) {
    const map = new Map<number, { m: number; width: number }>();
    for (let i = 0; i < n; i++) {
      const item = arr[i];
      if (item !== null && typeof item.t === 'number') {
        map.set(item.t, item);
      }
    }

    for (let i = 0; i < n; i++) {
      const item = arr[i];
      if (!item || typeof item.t !== 'number') {
        result[i] = 0;
        continue;
      }
      const dayT = item.t;
      const va1 = map.get(dayT - DAY_MS);
      const va2 = map.get(dayT - 2 * DAY_MS);
      if (!va1 || !va2) {
        result[i] = 0;
      } else {
        const diff = va1.m - va2.m;
        const cutoff = threshold * va2.width;
        if (diff > cutoff) {
          result[i] = 1;
        } else if (diff < -cutoff) {
          result[i] = -1;
        } else {
          result[i] = 0;
        }
      }
    }
    return result;
  }

  // Plain positional array (index i is day D, i-1 is D-1, i-2 is D-2)
  for (let i = 0; i < n; i++) {
    if (i < 2) {
      result[i] = 0;
      continue;
    }
    const va1 = arr[i - 1];
    const va2 = arr[i - 2];
    if (!va1 || !va2) {
      result[i] = 0;
    } else {
      const diff = va1.m - va2.m;
      const cutoff = threshold * va2.width;
      if (diff > cutoff) {
        result[i] = 1;
      } else if (diff < -cutoff) {
        result[i] = -1;
      } else {
        result[i] = 0;
      }
    }
  }

  return result;
}

/**
 * Groups 15m candles into UTC days and computes the ValueArea for each day.
 */
export function computeDailyValueAreas(
  candles15m: CandleRow[]
): Map<number, ValueArea | null> {
  const barsByDay = new Map<number, CandleRow[]>();
  for (let i = 0; i < candles15m.length; i++) {
    const bar = candles15m[i];
    const dayT = Math.floor(bar.t / DAY_MS) * DAY_MS;
    let list = barsByDay.get(dayT);
    if (!list) {
      list = [];
      barsByDay.set(dayT, list);
    }
    list.push(bar);
  }

  const vaMap = new Map<number, ValueArea | null>();
  for (const [dayT, dayBars] of barsByDay) {
    dayBars.sort((a, b) => a.t - b.t);
    vaMap.set(dayT, valueArea(dayBars));
  }

  return vaMap;
}

/**
 * Aligns daily signals and 1d candles into a CoinSeries for trade building:
 * t = 00:00 UTC of day D
 * close = 1d candle OPEN of day D (the entry price at day D's open)
 * side = directional signal for day D
 */
export function coinDailySeries(
  symbol: string,
  candles15mOrValueAreas: CandleRow[] | Map<number, ValueArea | null>,
  candles1d: CandleRow[],
  threshold: number = NV1_C3.threshold,
  range?: { from?: number; to?: number }
): CoinSeries {
  const vaMap =
    candles15mOrValueAreas instanceof Map
      ? candles15mOrValueAreas
      : computeDailyValueAreas(candles15mOrValueAreas);

  const sorted1d = [...candles1d].sort((a, b) => a.t - b.t);

  const t: number[] = [];
  const close: number[] = [];
  const side: number[] = [];

  for (let i = 0; i < sorted1d.length; i++) {
    const c = sorted1d[i];
    if (range) {
      if (range.from !== undefined && c.t < range.from) continue;
      if (range.to !== undefined && c.t >= range.to) continue;
    }

    const dayT = c.t;
    const va1 = vaMap.get(dayT - DAY_MS);
    const va2 = vaMap.get(dayT - 2 * DAY_MS);

    let s = 0;
    if (va1 && va2) {
      const diff = va1.m - va2.m;
      const cutoff = threshold * va2.width;
      if (diff > cutoff) {
        s = 1;
      } else if (diff < -cutoff) {
        s = -1;
      }
    }

    t.push(dayT);
    close.push(c.o);
    side.push(s);
  }

  return { symbol, t, close, side };
}

export interface ScreenCellResult {
  k: number;
  nB: number;
  nC: number;
  nPooled: number;
  nullP90: number;
  countB: number;
  countC: number;
  countPooled: number;
  buyCount: number;
  sellCount: number;
  bh: number;
  survives: boolean;
}

export interface ScreenResult {
  threshold: number;
  cells: ScreenCellResult[];
  survivor: number | null;
  forwardChoice: number | null;
  nullPromotionRate: number;
}

export interface ScreenOptions {
  threshold?: number;
  draws?: number;
  seed?: number;
  minShiftBars?: number;
  costPct?: number;
  hold?: number;
  stepMs?: number;
  fromB?: number;
  toB?: number;
  fromC?: number;
  toC?: number;
}

/**
 * Runs the C3 screen across confirmation delays k in {0, 1, 2, 3} over segments B and C.
 * Judged against the persistence-preserving null distribution with nullN.
 */
export function screen(coins: CoinSeries[], opts: ScreenOptions = {}): ScreenResult {
  const threshold = opts.threshold ?? NV1_C3.threshold;
  const draws = opts.draws ?? NV1_C3.nullDraws;
  const seed = opts.seed ?? NV1_C3.nullSeed;
  const minShiftBars = opts.minShiftBars ?? NV1_C3.minShiftBars;
  const costPct = opts.costPct ?? NV1_C3.costPct;
  const hold = opts.hold ?? NV1_C3.hold;
  const stepMs = opts.stepMs ?? DAY_MS;

  const fromB = opts.fromB ?? NV1_SEGMENTS.B.start;
  const toB = opts.toB ?? NV1_SEGMENTS.B.end;
  const fromC = opts.fromC ?? NV1_SEGMENTS.C.start;
  const toC = opts.toC ?? NV1_SEGMENTS.C.end;

  const ks = [...NV1_C3.ks];

  const basePooled: Omit<TradeOptions, 'k' | 'blocked'> = {
    hold,
    stepMs,
    costPct,
    from: fromB,
    to: toC,
  };

  // 1. Run null simulation for pooled B and C
  const nullMatrix = nullN(coins, ks, basePooled, draws, minShiftBars, seed);
  const nullP90: number[] = ks.map((_, ki) =>
    quantile7(
      nullMatrix.map((row) => row[ki]),
      NV1_C3.nullQuantile
    )
  );

  // 2. Compute expected null promotion rate from the null draws split into B and C
  const random = createSeededRandom(seed);
  const preparedCoins = coins.map((coin) => {
    const n = coin.side.length;
    const t = new Float64Array(coin.t);
    const close = new Float64Array(coin.close);
    const origSide = new Int8Array(coin.side);
    const rotSide = new Int8Array(n);
    return {
      symbol: coin.symbol,
      n,
      t,
      close,
      origSide,
      rotSide,
      coinData: {
        symbol: coin.symbol,
        t,
        close,
        side: rotSide,
      },
    };
  });

  let promotedDrawsCount = 0;

  for (let d = 0; d < draws; d++) {
    const u = drawFraction(coins, minShiftBars, random);
    const wrap: number[] = new Array(preparedCoins.length);

    for (let c = 0; c < preparedCoins.length; c++) {
      const pc = preparedCoins[c];
      const n = pc.n;
      const offset = Math.round(u * n);
      wrap[c] = offset;
      const split = n - offset;
      pc.rotSide.set(pc.origSide.subarray(split), 0);
      pc.rotSide.set(pc.origSide.subarray(0, split), offset);
    }

    let drawPromoted = false;

    for (let ki = 0; ki < ks.length; ki++) {
      const k = ks[ki];
      const p90 = nullP90[ki];
      const pooledN = nullMatrix[d][ki];

      if (Number.isFinite(pooledN) && pooledN > p90) {
        let sumB = 0;
        let countB = 0;
        let sumC = 0;
        let countC = 0;

        for (let c = 0; c < preparedCoins.length; c++) {
          const pc = preparedCoins[c];
          const wrapIndex = wrap[c];

          const resB = sumNetTrades(pc.coinData, {
            hold,
            stepMs,
            costPct,
            from: fromB,
            to: toB,
            k,
            blocked: (index: number) => index === wrapIndex,
          });
          sumB += resB.sum;
          countB += resB.count;

          const resC = sumNetTrades(pc.coinData, {
            hold,
            stepMs,
            costPct,
            from: fromC,
            to: toC,
            k,
            blocked: (index: number) => index === wrapIndex,
          });
          sumC += resC.sum;
          countC += resC.count;
        }

        const nB = countB > 0 ? sumB / countB : Number.NaN;
        const nC = countC > 0 ? sumC / countC : Number.NaN;

        if (Number.isFinite(nB) && nB > 0 && Number.isFinite(nC) && nC > 0) {
          drawPromoted = true;
          break;
        }
      }
    }

    if (drawPromoted) {
      promotedDrawsCount++;
    }
  }

  const nullPromotionRate = draws > 0 ? promotedDrawsCount / draws : 0;

  // 3. Compute actual metrics per k
  const cells: ScreenCellResult[] = [];

  for (let ki = 0; ki < ks.length; ki++) {
    const k = ks[ki];

    let sumB = 0;
    let countB = 0;
    let sumC = 0;
    let countC = 0;
    let sumPooled = 0;
    let countPooled = 0;

    let buyCount = 0;
    let buyHits = 0;
    let sellCount = 0;
    let sellHits = 0;

    for (let c = 0; c < coins.length; c++) {
      const coin = coins[c];

      const resB = sumNetTrades(coin, {
        hold,
        stepMs,
        costPct,
        from: fromB,
        to: toB,
        k,
      });
      sumB += resB.sum;
      countB += resB.count;

      const resC = sumNetTrades(coin, {
        hold,
        stepMs,
        costPct,
        from: fromC,
        to: toC,
        k,
      });
      sumC += resC.sum;
      countC += resC.count;

      const resPooled = sumNetTrades(coin, {
        hold,
        stepMs,
        costPct,
        from: fromB,
        to: toC,
        k,
      });
      sumPooled += resPooled.sum;
      countPooled += resPooled.count;

      const actualTrades = buildTrades(coin, {
        hold,
        stepMs,
        costPct,
        from: fromB,
        to: toC,
        k,
      });

      for (let tIdx = 0; tIdx < actualTrades.length; tIdx++) {
        const tr = actualTrades[tIdx];
        if (tr.d === 1) {
          buyCount++;
          if (tr.grossPct > 0) buyHits++;
        } else if (tr.d === -1) {
          sellCount++;
          if (tr.grossPct > 0) sellHits++;
        }
      }
    }

    const nB = countB > 0 ? sumB / countB : Number.NaN;
    const nC = countC > 0 ? sumC / countC : Number.NaN;
    const nPooled = countPooled > 0 ? sumPooled / countPooled : Number.NaN;

    const hitBuy = buyCount > 0 ? buyHits / buyCount : Number.NaN;
    const hitSell = sellCount > 0 ? sellHits / sellCount : Number.NaN;

    let bh = Number.NaN;
    if (Number.isFinite(hitBuy) && Number.isFinite(hitSell)) {
      bh = (hitBuy + hitSell) / 2;
    } else if (Number.isFinite(hitBuy)) {
      bh = hitBuy;
    } else if (Number.isFinite(hitSell)) {
      bh = hitSell;
    }

    const p90 = nullP90[ki];
    const survives =
      Number.isFinite(nB) &&
      nB > 0 &&
      Number.isFinite(nC) &&
      nC > 0 &&
      Number.isFinite(nPooled) &&
      nPooled > p90;

    cells.push({
      k,
      nB,
      nC,
      nPooled,
      nullP90: p90,
      countB,
      countC,
      countPooled,
      buyCount,
      sellCount,
      bh,
      survives,
    });
  }

  // Forward choice is surviving k with highest pooled N
  let survivor: number | null = null;
  let highestPooledN = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c.survives && c.nPooled > highestPooledN) {
      highestPooledN = c.nPooled;
      survivor = c.k;
    }
  }

  return {
    threshold,
    cells,
    survivor,
    forwardChoice: survivor,
    nullPromotionRate,
  };
}

export interface CliArgs {
  command: 'run';
  datasetDir: string;
  out: string;
  threshold: number;
}

export function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0 || argv[0] !== 'run') {
    throw new Error('Expected command "run"');
  }

  let datasetDir: string | null = null;
  let out: string | null = null;
  let threshold: number = NV1_C3.threshold;

  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      return v;
    };

    if (flag === '--dataset-dir') {
      datasetDir = value();
    } else if (flag === '--out') {
      out = value();
    } else if (flag === '--threshold') {
      threshold = Number.parseFloat(value());
      if (!Number.isFinite(threshold) || threshold <= 0) {
        throw new Error('--threshold must be a positive number');
      }
    } else {
      throw new Error(`Unknown flag "${flag}"`);
    }
  }

  if (!datasetDir) throw new Error('--dataset-dir is required');
  if (!out) throw new Error('--out is required');

  return { command: 'run', datasetDir, out, threshold };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) {
    throw new Error(`verifyManifest failed: ${verify.mismatches.join(', ')}`);
  }

  const manifest = loadManifest(args.datasetDir);

  // Load 15m and 1d candles for NV1_SYMBOLS without allowHoldoutA (holdout A dropped)
  const vaMapBySymbol = new Map<string, Map<number, ValueArea | null>>();
  const candles1dBySymbol = new Map<string, CandleRow[]>();

  for (const sym of NV1_SYMBOLS) {
    const c15m = loadCandles(args.datasetDir, sym, '15m', {
      allowHoldoutA: false,
      allowLockbox: false,
    }).rows;

    const c1d = loadCandles(args.datasetDir, sym, '1d', {
      allowHoldoutA: false,
      allowLockbox: false,
    }).rows.filter((c) => c.t >= NV1_SEGMENTS.B.start && c.t < NV1_SEGMENTS.C.end);

    vaMapBySymbol.set(sym, computeDailyValueAreas(c15m));
    candles1dBySymbol.set(sym, c1d);
  }

  // Primary screen
  const primaryCoins = NV1_SYMBOLS.map((sym) =>
    coinDailySeries(
      sym,
      vaMapBySymbol.get(sym)!,
      candles1dBySymbol.get(sym)!,
      args.threshold
    )
  );
  const primaryResult = screen(primaryCoins, { threshold: args.threshold });

  // Plateau screens from NV1_C3.plateauThresholds
  const plateau: Record<string, ScreenResult> = {};
  for (const th of NV1_C3.plateauThresholds) {
    const coinsPlateau = NV1_SYMBOLS.map((sym) =>
      coinDailySeries(
        sym,
        vaMapBySymbol.get(sym)!,
        candles1dBySymbol.get(sym)!,
        th
      )
    );
    plateau[String(th)] = screen(coinsPlateau, { threshold: th });
  }

  const finalOutput = {
    datasetHash: manifest.datasetHash,
    threshold: args.threshold,
    screen: primaryResult,
    plateau,
  };

  writeFileSync(args.out, JSON.stringify(finalOutput, null, 2), 'utf8');

  console.log(
    JSON.stringify({
      datasetHash: manifest.datasetHash,
      survivor: primaryResult.survivor,
      nullPromotionRate: primaryResult.nullPromotionRate,
      cells: primaryResult.cells.map((c) => ({
        k: c.k,
        nB: c.nB,
        nC: c.nC,
        nPooled: c.nPooled,
        nullP90: c.nullP90,
        survives: c.survives,
      })),
      plateau015Survivor: plateau[String(NV1_C3.plateauThresholds[0])]?.survivor,
      plateau035Survivor: plateau[String(NV1_C3.plateauThresholds[1])]?.survivor,
    })
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
