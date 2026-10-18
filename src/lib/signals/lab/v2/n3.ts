export const DAY_MS = 86_400_000;
export const DAY = DAY_MS;

export interface Bar15 {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export const N3 = {
  bins: 200,
  valueAreaShare: 0.7,
  minBarsPerDay: 90,
  threshold: 0.25,
  k: 1,
  costPerTrade: 0.0014,
} as const;

export interface ValueArea {
  poc: number;
  vah: number;
  val: number;
  m: number;
  width: number;
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
export function valueAreaOfDay(bars: Bar15[]): ValueArea | null {
  if (bars.length < N3.minBarsPerDay) {
    return null;
  }

  let dayLow = Number.POSITIVE_INFINITY;
  let dayHigh = Number.NEGATIVE_INFINITY;
  let totalVolume = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.l < dayLow) dayLow = bar.l;
    if (bar.h > dayHigh) dayHigh = bar.h;
    if (bar.v > 0) totalVolume += bar.v;
  }

  if (
    !Number.isFinite(dayLow) ||
    !Number.isFinite(dayHigh) ||
    dayHigh <= dayLow ||
    totalVolume <= 0
  ) {
    return null;
  }

  const binWidth = (dayHigh - dayLow) / N3.bins;
  const binVolume = new Float64Array(N3.bins);

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const vol = bar.v;
    if (vol <= 0) continue;

    if (bar.h === bar.l) {
      let b = Math.floor((bar.c - dayLow) / binWidth);
      if (b < 0) b = 0;
      if (b >= N3.bins) b = N3.bins - 1;
      binVolume[b] += vol;
    } else {
      const barLen = bar.h - bar.l;
      const startBin = Math.max(
        0,
        Math.min(N3.bins - 1, Math.floor((bar.l - dayLow) / binWidth))
      );
      const endBin = Math.max(
        0,
        Math.min(N3.bins - 1, Math.floor((bar.h - dayLow) / binWidth))
      );

      for (let b = startBin; b <= endBin; b++) {
        const bLow = b === 0 ? dayLow : dayLow + b * binWidth;
        const bHigh = b === N3.bins - 1 ? dayHigh : dayLow + (b + 1) * binWidth;
        const overlap = Math.max(0, Math.min(bar.h, bHigh) - Math.max(bar.l, bLow));
        if (overlap > 0) {
          binVolume[b] += vol * (overlap / barLen);
        }
      }
    }
  }

  // POC selection: maximum volume, ties broken by nearest to day's last close, then lower bin
  const lastClose = bars[bars.length - 1].c;
  let pocBin = 0;
  let bestVol = -1;
  let bestDist = Number.POSITIVE_INFINITY;

  for (let b = 0; b < N3.bins; b++) {
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
  const targetVolume = N3.valueAreaShare * totalVolume;
  let lowBin = pocBin;
  let highBin = pocBin;
  let includedVolume = binVolume[pocBin];

  while (
    includedVolume < targetVolume - 1e-12 &&
    (lowBin > 0 || highBin < N3.bins - 1)
  ) {
    const nextAbove = highBin + 1;
    const nextBelow = lowBin - 1;
    const hasAbove = nextAbove < N3.bins;
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

  const vah =
    highBin === N3.bins - 1 ? dayHigh : dayLow + (highBin + 1) * binWidth;
  const val = lowBin === 0 ? dayLow : dayLow + lowBin * binWidth;
  const m = (vah + val) / 2;
  const width = vah - val;
  const poc = dayLow + (pocBin + 0.5) * binWidth;

  return { poc, vah, val, m, width };
}

/**
 * Groups 15m candles into UTC days and computes the ValueArea for each day.
 */
export function dailyValueAreas(
  bars: Bar15[]
): Map<number, ReturnType<typeof valueAreaOfDay>> {
  const barsByDay = new Map<number, Bar15[]>();
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const dayT = Math.floor(bar.t / DAY_MS) * DAY_MS;
    let list = barsByDay.get(dayT);
    if (!list) {
      list = [];
      barsByDay.set(dayT, list);
    }
    list.push(bar);
  }

  const vaMap = new Map<number, ReturnType<typeof valueAreaOfDay>>();
  for (const [dayT, dayBars] of barsByDay) {
    dayBars.sort((a, b) => a.t - b.t);
    vaMap.set(dayT, valueAreaOfDay(dayBars));
  }

  return vaMap;
}

/**
 * Directional side for day D from the value areas of D - 1 and D - 2:
 * +1 if m(D-1) - m(D-2) > threshold * width(D-2)
 * -1 if m(D-1) - m(D-2) < -threshold * width(D-2)
 * 0 otherwise (and 0 when either day lacks a value area).
 */
export function sideOfDay(
  vas:
    | Map<number, ReturnType<typeof valueAreaOfDay>>
    | ReadonlyMap<number, ReturnType<typeof valueAreaOfDay>>,
  dayT: number,
  threshold: number = N3.threshold
): -1 | 0 | 1 {
  const va1 = vas.get(dayT - DAY_MS);
  const va2 = vas.get(dayT - 2 * DAY_MS);

  if (!va1 || !va2) {
    return 0;
  }

  const diff = va1.m - va2.m;
  const cutoff = threshold * va2.width;
  if (diff > cutoff) {
    return 1;
  }
  if (diff < -cutoff) {
    return -1;
  }
  return 0;
}

/**
 * Position for day D under confirmation delay k = 1:
 * sideOfDay(D) when non-zero and equal to sideOfDay(D - 1), else 0.
 * Requires value areas for D - 1, D - 2 and D - 3.
 */
export function n3Position(
  vas:
    | Map<number, ReturnType<typeof valueAreaOfDay>>
    | ReadonlyMap<number, ReturnType<typeof valueAreaOfDay>>,
  dayT: number,
  threshold: number = N3.threshold
): -1 | 0 | 1 {
  const sideD = sideOfDay(vas, dayT, threshold);
  if (sideD === 0) {
    return 0;
  }
  const sidePrev = sideOfDay(vas, dayT - DAY_MS, threshold);
  if (sideD === sidePrev) {
    return sideD;
  }
  return 0;
}

/**
 * UTC time window of 15m bars needed to score day D:
 * the three full prior UTC days [dayT - 3 * DAY, dayT - 1].
 */
export function n3BarsNeeded(dayT: number): {
  startTime: number;
  endTime: number;
} {
  return {
    startTime: dayT - 3 * DAY_MS,
    endTime: dayT - 1,
  };
}
