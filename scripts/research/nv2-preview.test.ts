import { describe, expect, it } from 'vitest';
import type { FundingRow, PerpCandleRow } from './dataset-format';
import {
  DAY_MS,
  DELISTING_HAIRCUT,
  costOf,
  dayReturn,
  dayStartMs,
  fundingOf,
  roundUp2SigFigs,
  signalsAt,
  slippageOfRank,
  staggeredBook,
  targetBook,
  valueBook,
} from './nv2-preview';

function makeCandle(
  t: number,
  o: number,
  c: number,
  h: number = Math.max(o, c),
  l: number = Math.min(o, c),
  v: number = 1000
): PerpCandleRow {
  return {
    t,
    o,
    h,
    l,
    c,
    v,
    qv: v * c,
    n: 100,
    tbv: v / 2,
  };
}

function makeFunding(t: number, rate: number): FundingRow {
  return {
    t,
    rate,
    intervalHours: 8,
  };
}

describe('nv2-preview', () => {
  it('mom1 at D uses the bar with t = D - 1 day, and changing the bar with t = D does not change any score at D (no look-ahead)', () => {
    const D = dayStartMs('2024-05-10');

    // Bar closed by D: t = D - 1 day
    const barDMinus1 = makeCandle(D - DAY_MS, 100, 110); // return c/o - 1 = 0.10
    // Bar formed at D: t = D, closes at D + 1 day
    const barD = makeCandle(D, 110, 150);

    const initialBars = [barDMinus1, barD];
    const scores1 = signalsAt(D, initialBars, []);

    expect(scores1.mom1).toBeCloseTo(0.10, 8);

    // Modify the bar at t = D (e.g. drastic price surge or crash)
    const barDModified = makeCandle(D, 50, 999);
    const modifiedBars = [barDMinus1, barDModified];
    const scores2 = signalsAt(D, modifiedBars, []);

    // Score at D must not change at all
    expect(scores2.mom1).toBeCloseTo(0.10, 8);
    expect(scores2.mom1).toBe(scores1.mom1);
    expect(scores2.rev7).toBe(scores1.rev7);
    expect(scores2.lottery30).toBe(scores1.lottery30);
    expect(scores2.fund7).toBe(scores1.fund7);
    expect(scores2.fundChange).toBe(scores1.fundChange);
  });

  it('fund7 uses settlements in (D - 7d, D] only', () => {
    const D = dayStartMs('2024-05-10');
    const start7 = D - 7 * DAY_MS;

    const settlements: FundingRow[] = [];

    // Settlement exactly at D - 7d (must NOT be included in (D-7d, D])
    settlements.push(makeFunding(start7, 0.999));

    // 17 settlements inside (start7, D)
    for (let i = 1; i <= 17; i++) {
      const t = start7 + i * (DAY_MS / 3);
      settlements.push(makeFunding(t, 0.0002));
    }

    // Exactly at D (must be included, ] boundary)
    settlements.push(makeFunding(D, 0.0002));

    // Settlement after D (must NOT be included)
    settlements.push(makeFunding(D + 1000, 0.999));

    const scores = signalsAt(D, [], settlements);
    // 18 settlements of rate 0.0002 inside (start7, D]
    // score = - sum(rates) = - (18 * 0.0002) = - 0.0036
    expect(scores.fund7).not.toBeNull();
    expect(scores.fund7).toBeCloseTo(-0.0036, 8);

    // If we remove the settlement at D, we only have 17 settlements, so score must be null
    const settlementsIncomplete = settlements.filter((s) => s.t !== D);
    const scoresIncomplete = signalsAt(D, [], settlementsIncomplete);
    expect(scoresIncomplete.fund7).toBeNull();
  });

  it('the h7 book is the average of the last 7 targets', () => {
    const targets: Map<string, number>[] = [];

    // Create 7 targets
    // Coin A: weight in each target is 0.7, average over 7 should be 0.7
    // Coin B: weight 0.35 in only 2 targets, average over 7 should be (0.35 + 0.35) / 7 = 0.10
    // Coin C: empty / missing in all targets, average should be 0
    for (let i = 0; i < 7; i++) {
      const t = new Map<string, number>();
      t.set('COIN_A', 0.7);
      if (i < 2) {
        t.set('COIN_B', 0.35);
      }
      targets.push(t);
    }

    const staggered = staggeredBook(targets);
    expect(staggered.get('COIN_A')).toBeCloseTo(0.7, 8);
    expect(staggered.get('COIN_B')).toBeCloseTo(0.10, 8);
    expect(staggered.has('COIN_C')).toBe(false);

    // Test with fewer than 7 targets (e.g. 3 targets elapsed)
    // Missing targets count as zero weights (cash), still divided by 7
    const partialTargets = targets.slice(0, 3);
    const partialStaggered = staggeredBook(partialTargets);
    // COIN_A had 0.7 in 3 targets: (0.7 * 3) / 7 = 0.30
    expect(partialStaggered.get('COIN_A')).toBeCloseTo(0.30, 8);
  });

  it('the cost uses the rank tiers', () => {
    // Tiers:
    // ranks 1 to 10: slippage 0.0002
    // ranks 11 to 25: slippage 0.0005
    // ranks 26 and above: slippage 0.0010
    // Fee: 0.0005

    expect(slippageOfRank(1)).toBe(0.0002);
    expect(slippageOfRank(10)).toBe(0.0002);
    expect(slippageOfRank(11)).toBe(0.0005);
    expect(slippageOfRank(25)).toBe(0.0005);
    expect(slippageOfRank(26)).toBe(0.0010);
    expect(slippageOfRank(50)).toBe(0.0010);
    expect(slippageOfRank(undefined)).toBe(0.0010);

    const tradedAmount = 1.0;
    // Rank 5: 1.0 * (0.0005 + 0.0002) = 0.0007
    expect(costOf(tradedAmount, 5)).toBeCloseTo(0.0007, 8);

    // Rank 20: 1.0 * (0.0005 + 0.0005) = 0.0010
    expect(costOf(tradedAmount, 20)).toBeCloseTo(0.0010, 8);

    // Rank 30: 1.0 * (0.0005 + 0.0010) = 0.0015
    expect(costOf(tradedAmount, 30)).toBeCloseTo(0.0015, 8);

    // Traded amount 0.5 at rank 5: 0.5 * 0.0007 = 0.00035
    expect(costOf(0.5, 5)).toBeCloseTo(0.00035, 8);
  });

  it('the funding sign: a long receives minus the rates', () => {
    const D = dayStartMs('2024-05-10');

    // Case 1: Positive funding rate (longs pay shorts on Binance)
    const positiveSettlements = [
      makeFunding(D + 8 * 3600 * 1000, 0.0005),
      makeFunding(D + 16 * 3600 * 1000, 0.0005),
    ];
    // Sum of settlement rates is +0.0010
    // fundingOf returns minus sum: -0.0010
    const f1 = fundingOf(D, positiveSettlements);
    expect(f1).toBeCloseTo(-0.0010, 8);

    // A long position (+0.5) receives w * f = 0.5 * (-0.0010) = -0.0005 (pays funding)
    const longContribution1 = 0.5 * f1;
    expect(longContribution1).toBeCloseTo(-0.0005, 8);

    // A short position (-0.5) receives w * f = (-0.5) * (-0.0010) = +0.0005 (receives funding)
    const shortContribution1 = -0.5 * f1;
    expect(shortContribution1).toBeCloseTo(0.0005, 8);

    // Case 2: Negative funding rate (shorts pay longs)
    const negativeSettlements = [
      makeFunding(D + 8 * 3600 * 1000, -0.0005),
      makeFunding(D + 16 * 3600 * 1000, -0.0005),
    ];
    const f2 = fundingOf(D, negativeSettlements);
    expect(f2).toBeCloseTo(0.0010, 8);

    // Long receives positive return: 0.5 * 0.0010 = +0.0005
    expect(0.5 * f2).toBeCloseTo(0.0005, 8);
    // Short pays negative return: -0.5 * 0.0010 = -0.0005
    expect(-0.5 * f2).toBeCloseTo(-0.0005, 8);
  });

  it('a missing next-day bar applies the 2% haircut', () => {
    const D = dayStartMs('2024-05-10');
    const barD = makeCandle(D, 100, 105);

    // Normal case: bar at D+1 exists with open 108
    const barD1 = makeCandle(D + DAY_MS, 108, 110);
    const rNormal = dayReturn(barD, barD1);
    // o(D+1)/o(D) - 1 = 108/100 - 1 = 0.08
    expect(rNormal).toBeCloseTo(0.08, 8);

    // Delisting case: next-day bar is missing (null)
    const rDelisted = dayReturn(barD, null);
    // c(D)/o(D) - 1 - 0.02 = 105/100 - 1 - 0.02 = 0.05 - 0.02 = 0.03
    expect(rDelisted).toBeCloseTo(0.05 - DELISTING_HAIRCUT, 8);
    expect(rDelisted).toBeCloseTo(0.03, 8);
  });

  it('fewer than 10 scored coins gives cash', () => {
    // 9 scored coins
    const scores9 = new Map<string, number>();
    for (let i = 1; i <= 9; i++) {
      scores9.set(`COIN_${i}`, i);
    }
    const book9 = targetBook(scores9);
    // Empty map represents 100% cash
    expect(book9.size).toBe(0);

    // Add 10th scored coin
    const scores10 = new Map(scores9);
    scores10.set('COIN_10', 10);
    const book10 = targetBook(scores10);
    expect(book10.size).toBe(10);

    // Check weights are dollar-neutral and sum to gross 1
    let sumWeights = 0;
    let absSumWeights = 0;
    for (const w of book10.values()) {
      sumWeights += w;
      absSumWeights += Math.abs(w);
    }
    expect(sumWeights).toBeCloseTo(0, 10);
    expect(absSumWeights).toBeCloseTo(1, 10);
  });

  it('rev7 needs all 8 daily bars or returns null', () => {
    const D = dayStartMs('2024-05-10');
    const bars: PerpCandleRow[] = [];
    for (let k = 1; k <= 8; k++) {
      bars.push(makeCandle(D - k * DAY_MS, 100, 100 + k));
    }
    const sComplete = signalsAt(D, bars, []);
    expect(sComplete.rev7).not.toBeNull();

    // Remove one bar in the window
    const barsIncomplete = bars.filter((b) => b.t !== D - 4 * DAY_MS);
    const sIncomplete = signalsAt(D, barsIncomplete, []);
    expect(sIncomplete.rev7).toBeNull();
  });

  it('lottery30 needs all 31 daily bars or returns null', () => {
    const D = dayStartMs('2024-05-10');
    const bars: PerpCandleRow[] = [];
    for (let k = 1; k <= 31; k++) {
      bars.push(makeCandle(D - k * DAY_MS, 100, 100 + (k % 5)));
    }
    const sComplete = signalsAt(D, bars, []);
    expect(sComplete.lottery30).not.toBeNull();

    // Remove one bar in the window
    const barsIncomplete = bars.filter((b) => b.t !== D - 15 * DAY_MS);
    const sIncomplete = signalsAt(D, barsIncomplete, []);
    expect(sIncomplete.lottery30).toBeNull();
  });

  it('roundUp2SigFigs rounds up correctly across scales', () => {
    expect(roundUp2SigFigs(0.03412)).toBeCloseTo(0.035, 8);
    expect(roundUp2SigFigs(0.04000)).toBeCloseTo(0.040, 8);
    expect(roundUp2SigFigs(0.04001)).toBeCloseTo(0.041, 8);
    expect(roundUp2SigFigs(0.0991)).toBeCloseTo(0.10, 8);
    expect(roundUp2SigFigs(1234)).toBe(1300);
    expect(roundUp2SigFigs(0)).toBe(0);
  });

  it('fund7 for an 8h coin with 21 settlements of 0.0001 equals -0.0021, and for a 4h coin with 42 settlements of 0.00005 also equals -0.0021', () => {
    const D = dayStartMs('2024-05-10');
    const start7 = D - 7 * DAY_MS;

    // 8h coin: 21 settlements in (D - 7d, D], one every 8 hours
    const settlements8h: FundingRow[] = [];
    for (let i = 1; i <= 21; i++) {
      settlements8h.push(makeFunding(start7 + i * 8 * 3600 * 1000, 0.0001));
    }
    const scores8h = signalsAt(D, [], settlements8h);
    expect(scores8h.fund7).not.toBeNull();
    expect(scores8h.fund7).toBeCloseTo(-0.0021, 8);

    // 4h coin: 42 settlements in (D - 7d, D], one every 4 hours
    const settlements4h: FundingRow[] = [];
    for (let i = 1; i <= 42; i++) {
      settlements4h.push(makeFunding(start7 + i * 4 * 3600 * 1000, 0.00005));
    }
    const scores4h = signalsAt(D, [], settlements4h);
    expect(scores4h.fund7).not.toBeNull();
    expect(scores4h.fund7).toBeCloseTo(-0.0021, 8);
  });

  it('a coin held in an h7 book that is not a member at D but has a bar at D contributes w * r to gross', () => {
    // Past targets: on D-3, COIN_DROPPED was a member and had target weight 0.70.
    // On day D, it dropped out of the top 30, so target at D has 0 weight for it.
    const targetD3 = new Map<string, number>([['COIN_DROPPED', 0.70]]);
    const targetD = new Map<string, number>([['COIN_ACTIVE', 0.50]]);

    // h7 book staggered over past targets: COIN_DROPPED has weight 0.70 / 7 = 0.10
    const h7 = staggeredBook([targetD, new Map(), new Map(), targetD3]);
    expect(h7.get('COIN_DROPPED')).toBeCloseTo(0.10, 8);

    // On day D:
    // COIN_DROPPED is not a member at D, but has a bar with return r = 0.05 and funding f = -0.001
    // COIN_ACTIVE is a member with r = 0.02 and f = 0.0005
    // COIN_MISSING is held (weight 0.05) but has no bar at D
    h7.set('COIN_MISSING', 0.05);

    const allCoins = new Map<string, { r: number; f: number }>([
      ['COIN_DROPPED', { r: 0.05, f: -0.001 }],
      ['COIN_ACTIVE', { r: 0.02, f: 0.0005 }],
    ]);

    const valuation = valueBook(h7, allCoins);

    // COIN_DROPPED contributes 0.10 * 0.05 = 0.005 to gross
    // COIN_ACTIVE weight is 0.50 / 7 = 0.07142857... -> contributes (0.50 / 7) * 0.02
    const expectedGross = 0.10 * 0.05 + (0.50 / 7) * 0.02;
    expect(valuation.gross).toBeCloseTo(expectedGross, 8);

    // Funding: 0.10 * (-0.001) + (0.50 / 7) * 0.0005
    const expectedFunding = 0.10 * -0.001 + (0.50 / 7) * 0.0005;
    expect(valuation.funding).toBeCloseTo(expectedFunding, 8);

    // COIN_MISSING had no bar at D, so missingHeld should be 1
    expect(valuation.missingHeld).toBe(1);
  });

  it('fundChange uses sum over (D - 7d, D] minus sum over (D - 14d, D - 7d]', () => {
    const D = dayStartMs('2024-05-15');
    const start7 = D - 7 * DAY_MS;
    const start14 = D - 14 * DAY_MS;

    const settlements: FundingRow[] = [];
    // 21 settlements in (D - 14d, D - 7d] with rate 0.0002 -> sum = 0.0042
    for (let i = 1; i <= 21; i++) {
      settlements.push(makeFunding(start14 + i * 8 * 3600 * 1000, 0.0002));
    }
    // 21 settlements in (D - 7d, D] with rate 0.0001 -> sum = 0.0021
    for (let i = 1; i <= 21; i++) {
      settlements.push(makeFunding(start7 + i * 8 * 3600 * 1000, 0.0001));
    }

    const scores = signalsAt(D, [], settlements);
    // fundChange = - (0.0021 - 0.0042) = 0.0021
    expect(scores.fundChange).not.toBeNull();
    expect(scores.fundChange).toBeCloseTo(0.0021, 8);
  });
});
