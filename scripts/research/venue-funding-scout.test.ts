// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { KlineCsvRow } from '@/lib/external/binance-archive';

import { HOUR_MS } from './carry-sim';
import { SCOUT_CUTOFF_MS, SCOUT_FROM_MS } from './funding-scout';
import {
  SPREAD_LEVELS,
  VENUE_COSTS,
  assertEndAllowed,
  bybitFundingUrl,
  bybitPremiumUrl,
  bybitSymbolFor,
  detectSpreadEpisodes,
  hyperliquidCandleBody,
  hyperliquidCoinFor,
  hyperliquidFundingBody,
  measureSpreadEpisode,
  measureSpreadEpisodeReal,
  parseArgs,
  parseBybitFunding,
  parseBybitInstruments,
  parseBybitPremium,
  parseHyperliquidCandles,
  parseHyperliquidFunding,
  parseHyperliquidMeta,
  scanWindow,
  summariseSpread,
  trailingSum,
  venueSlotBook,
  type FundingEvent,
  type HyperliquidCandle,
  type MeasuredSpreadEpisode,
  type SpreadEpisode,
  type VenueSlotRow,
} from './venue-funding-scout';

const T0 = Date.UTC(2023, 6, 1, 0);
const h = (hours: number): number => T0 + hours * HOUR_MS;

function bar(open: number, close: number, high = close, low = close): [number, KlineCsvRow] {
  return [
    open,
    { timestamp: open, open: close, high, low, close, volume: 1, quoteVolume: 1, trades: 1, takerBuyVolume: null },
  ];
}

describe('trailingSum', () => {
  it('excludes the event exactly 24h back and includes the one 23h back and the one at the time', () => {
    const at = h(100);
    const events: FundingEvent[] = [
      { t: at - 24 * HOUR_MS, rate: 1 },
      { t: at - 23 * HOUR_MS, rate: 10 },
      { t: at, rate: 100 },
      { t: at + HOUR_MS, rate: 1000 },
    ];
    expect(trailingSum(events, at)).toBe(110);
  });
  it('honours a custom window', () => {
    const events: FundingEvent[] = [
      { t: h(8), rate: 1 },
      { t: h(10), rate: 10 },
    ];
    expect(trailingSum(events, h(10), 2)).toBe(10);
    expect(trailingSum(events, h(10), 3)).toBe(11);
  });
});

describe('detectSpreadEpisodes', () => {
  // Hours are counted from T0 (h(0)).
  //   base  : Binance 8h events of 0.0001 at hours 0, 8, 16, ..., 112. Any 24h window (T-24h, T] holds exactly 3
  //           of them once T >= 23, so the base sum is a constant 0.0003.
  //   other : hourly events at hours 0..119, 0.00002 for hours 0..29, 0.0001 for hours 30..59, 0 for hours 60..119.
  // Scan window: fromT = max(first events 0, 0) + 24h = hour 24, toT = min(112, 119) = hour 112.
  // The brief's example (0.0001 for 30 hours first) would already give spread 24 x 0.0001 - 0.0003 = 0.0021 at
  // hour 24, so the entry would be the first decision time and prove nothing. A low first phase moves the entry.
  //
  // Rise. At hour h in 30..53 the window (h-24, h] holds k = h - 29 events of 0.0001 and 24 - k of 0.00002:
  //   spread = k x 0.0001 + (24 - k) x 0.00002 - 0.0003 = 0.00018 + 0.00008 k.
  //   level 0.001: k = 10 (hour 39) gives 0.00098 < 0.001, k = 11 (hour 40) gives 0.00106 >= 0.001. Entry hour 40.
  //   level 0.002: k = 22 (hour 51) gives 0.00194, k = 23 (hour 52) gives 0.00202. Entry hour 52.
  //   Before hour 30 the spread is 24 x 0.00002 - 0.0003 = 0.00018, below both levels, so hour 24 is not an entry.
  // Fall. For h >= 60 the 0.0001 events still in the window are hours h-23..59, which is 83 - h of them:
  //   spread = (83 - h) x 0.0001 - 0.0003. Hour 79: 4 events, 0.0001 > 0. Hour 80: 3 events, 0.0003 - 0.0003 = 0,
  //   which is <= 0, so the exit is hour 80. After it the spread is 0 or negative with |spread| <= 0.0003 < level,
  //   so no second episode starts.
  const base: FundingEvent[] = Array.from({ length: 15 }, (_, i) => ({ t: h(i * 8), rate: 0.0001 }));
  const other: FundingEvent[] = Array.from({ length: 120 }, (_, i) => ({
    t: h(i),
    rate: i < 30 ? 0.00002 : i < 60 ? 0.0001 : 0,
  }));

  it('finds the scan window', () => {
    expect(scanWindow(base, other)).toEqual({ fromT: h(24), toT: h(112) });
    expect(scanWindow([], other)).toBeNull();
    expect(scanWindow(base.slice(0, 2), other)).toBeNull();
  });

  it('enters at hour 40 and exits at hour 80 at level 0.001, sign +1', () => {
    const episodes = detectSpreadEpisodes(base, other, 0.001, h(24), h(112));
    expect(episodes).toEqual([{ level: 0.001, sign: 1, entryT: h(40), exitT: h(80), truncated: false }]);
  });

  it('enters at hour 52 at level 0.002', () => {
    const episodes = detectSpreadEpisodes(base, other, 0.002, h(24), h(112));
    expect(episodes).toEqual([{ level: 0.002, sign: 1, entryT: h(52), exitT: h(80), truncated: false }]);
  });

  it('truncates an episode still open at the last decision time', () => {
    const episodes = detectSpreadEpisodes(base, other, 0.001, h(24), h(70));
    expect(episodes).toEqual([{ level: 0.001, sign: 1, entryT: h(40), exitT: h(70), truncated: true }]);
  });

  it('gives sign -1 when the roles are swapped', () => {
    const episodes = detectSpreadEpisodes(other, base, 0.001, h(24), h(112));
    expect(episodes).toEqual([{ level: 0.001, sign: -1, entryT: h(40), exitT: h(80), truncated: false }]);
  });

  it('starts nothing when the spread never reaches the level', () => {
    expect(detectSpreadEpisodes(base, other, 0.005, h(24), h(112))).toEqual([]);
  });

  it('gives the same episodes when stepHours is omitted or 1', () => {
    const omitted = detectSpreadEpisodes(base, other, 0.001, h(24), h(112));
    expect(detectSpreadEpisodes(base, other, 0.001, h(24), h(112), 1)).toEqual(omitted);
    expect(omitted).toEqual([{ level: 0.001, sign: 1, entryT: h(40), exitT: h(80), truncated: false }]);
  });

  // On the 8h grid (T0 is a multiple of 8h UTC) decisions fall at hours 32, 40, ..., 112 when fromT is hour 25.
  //   level 0.001: hour 32 has k = 3, spread 0.00042 < level. Hour 40 has k = 11, spread 0.00106 >= level, previous
  //     decision below level: entry hour 40. Hour 80 is the first decision with spread 0: exit hour 80.
  //   level 0.002: hour 48 has k = 19, spread 0.0017 < level. Hour 56 holds 24 events of 0.0001, spread 0.0021
  //     >= level: entry hour 56 (the hourly grid enters at hour 52). Exit hour 80.
  it('decides only at multiples of 8h UTC when stepHours is 8', () => {
    const low = detectSpreadEpisodes(base, other, 0.001, h(25), h(112), 8);
    const high = detectSpreadEpisodes(base, other, 0.002, h(25), h(112), 8);
    expect(low).toEqual([{ level: 0.001, sign: 1, entryT: h(40), exitT: h(80), truncated: false }]);
    expect(high).toEqual([{ level: 0.002, sign: 1, entryT: h(56), exitT: h(80), truncated: false }]);
    for (const ep of [...low, ...high]) {
      expect(ep.entryT % (8 * HOUR_MS)).toBe(0);
      expect(ep.exitT % (8 * HOUR_MS)).toBe(0);
    }
  });

  it('truncates at the last 8h decision time', () => {
    const episodes = detectSpreadEpisodes(base, other, 0.001, h(24), h(70), 8);
    expect(episodes).toEqual([{ level: 0.001, sign: 1, entryT: h(40), exitT: h(64), truncated: true }]);
  });
});

describe('measureSpreadEpisode', () => {
  // entryT = hour 9, exitT = hour 13, sign +1 (short the other venue, long Binance), hold 4h.
  // base events: hour 8 (before entry, excluded), hour 12 0.0003 (collected), hour 16 (after exit, excluded).
  // other events 0.0002 hourly at hours 9..14: hours 10..13 collected (hour 9 is the entry, hour 14 is past the exit).
  //   grossFunding = 1 x (4 x 0.0002 - 0.0003) = 0.0005.
  // Hyperliquid premium of the other venue is keyed by the event time: hour 9 0.0010, hour 13 0.0016.
  // Binance premium is the bar open T-1h: hour 8 (entry) 0.0004, hour 12 (exit) 0.0001.
  //   basisApprox = -1 x [(0.0016 - 0.0001) - (0.0010 - 0.0004)] = -(0.0015 - 0.0006) = -0.0009.
  // Hyperliquid perSide: taker 0.0005 + 0.00045 + 0.0006 = 0.00155, maker 0.00035.
  //   net taker = 0.0005 - 0.0009 - 2 x 0.00155 = -0.0035, net maker = -0.0004 - 0.0007 = -0.0011.
  // Price path: entry close is bar hour 8 = 100. Bars hours 9..12 have max high 101.5 and min low 60:
  //   upMove 0.015, downMove 0.4, worstLeg 0.4. 2x threshold 0.5 - 0.005 = 0.495 (not hit), 3x 1/3 - 0.005 = 0.3283 (hit).
  const ep: SpreadEpisode = { level: 0.001, sign: 1, entryT: h(9), exitT: h(13), truncated: false };
  const baseEvents: FundingEvent[] = [
    { t: h(8), rate: 0.0001 },
    { t: h(12), rate: 0.0003 },
    { t: h(16), rate: 0.0001 },
  ];
  const otherEvents: FundingEvent[] = [9, 10, 11, 12, 13, 14].map((hour) => ({ t: h(hour), rate: 0.0002 }));
  const basePremium = new Map<number, number>([
    [h(8), 0.0004],
    [h(12), 0.0001],
  ]);
  const hlPremium = new Map<number, number>([
    [h(9), 0.001],
    [h(13), 0.0016],
  ]);
  const perp = new Map<number, KlineCsvRow>([
    bar(h(8), 100),
    bar(h(9), 100, 101, 99),
    bar(h(10), 100, 101.5, 99),
    bar(h(11), 100, 100, 60),
    bar(h(12), 100),
  ]);
  const costs = VENUE_COSTS.hyperliquid;

  it('measures a Hyperliquid episode', () => {
    const m = measureSpreadEpisode(ep, baseEvents, otherEvents, basePremium, hlPremium, perp, costs, 'hyperliquid');
    expect(m.status).toBe('ok');
    expect(m.missingBars).toBe(0);
    expect(m.grossFunding).toBeCloseTo(0.0005, 12);
    expect(m.basisApprox).toBeCloseTo(-0.0009, 12);
    expect(m.net?.taker).toBeCloseTo(-0.0035, 12);
    expect(m.net?.maker).toBeCloseTo(-0.0011, 12);
    expect(m.upMove).toBeCloseTo(0.015, 12);
    expect(m.downMove).toBeCloseTo(0.4, 12);
    expect(m.worstLeg).toBeCloseTo(0.4, 12);
    expect(m.liquidated).toEqual({ '2x': false, '3x': true });
    expect(m.holdHours).toBe(4);
    expect(m.otherEventsCollected).toBe(4);
    expect(m.baseEventsCollected).toBe(1);
  });

  it('reads Bybit premium at the bar open T - 1h', () => {
    const bybitPremium = new Map<number, number>([
      [h(8), 0.001],
      [h(12), 0.0016],
    ]);
    const m = measureSpreadEpisode(
      ep,
      baseEvents,
      otherEvents,
      basePremium,
      bybitPremium,
      perp,
      VENUE_COSTS.bybit,
      'bybit'
    );
    expect(m.status).toBe('ok');
    expect(m.basisApprox).toBeCloseTo(-0.0009, 12);
    // Bybit taker perSide 0.0005 + 0.00055 + 0.0006 = 0.00165.
    expect(m.net?.taker).toBeCloseTo(0.0005 - 0.0009 - 2 * 0.00165, 12);
  });

  it('flips funding and basis for sign -1', () => {
    const m = measureSpreadEpisode(
      { ...ep, sign: -1 },
      baseEvents,
      otherEvents,
      basePremium,
      hlPremium,
      perp,
      costs,
      'hyperliquid'
    );
    expect(m.grossFunding).toBeCloseTo(-0.0005, 12);
    expect(m.basisApprox).toBeCloseTo(0.0009, 12);
  });

  it('flags a missing premium and computes the net without basis', () => {
    const missing = new Map(hlPremium);
    missing.delete(h(13));
    const m = measureSpreadEpisode(ep, baseEvents, otherEvents, basePremium, missing, perp, costs, 'hyperliquid');
    expect(m.status).toBe('no-premium');
    expect(m.basisApprox).toBeNull();
    expect(m.grossFunding).toBeCloseTo(0.0005, 12);
    expect(m.net?.taker).toBeCloseTo(0.0005 - 0.0031, 12);
    expect(m.worstLeg).toBeCloseTo(0.4, 12);
  });

  it('reports a gap when a price bar is missing', () => {
    const gappy = new Map(perp);
    gappy.delete(h(10));
    const m = measureSpreadEpisode(ep, baseEvents, otherEvents, basePremium, hlPremium, gappy, costs, 'hyperliquid');
    expect(m.status).toBe('gap');
    expect(m.missingBars).toBe(1);
    expect(m.net).toBeNull();
  });

  it('reports an empty episode', () => {
    const m = measureSpreadEpisode(
      { ...ep, exitT: ep.entryT },
      baseEvents,
      otherEvents,
      basePremium,
      hlPremium,
      perp,
      costs,
      'hyperliquid'
    );
    expect(m.status).toBe('empty');
  });
});

describe('measureSpreadEpisodeReal', () => {
  // sign +1, entryT = hour 0, exitT = hour 24, hold 24h.
  // Binance 1h opens: 100 at hour 0, 103 at hour 24, flat 100 on the bars of hours 1..23.
  // Hyperliquid 8h candle opens: 50 at hours 0, 8, 16 (flat) and 49 at hour 24.
  //   basis = (103/100 - 1) - (49/50 - 1) = 0.03 + 0.02 = 0.05.
  // Funding. Hyperliquid events: hour 0 (entry, excluded), 8 0.0002, 16 0.0003, 24 0.0001 (3 collected), hour 32
  // (past the exit, excluded). Binance events: hour 0 (excluded), hour 8 0.0004 (1 collected), hour 32 (excluded).
  //   grossFunding = 1 x ((0.0002 + 0.0003 + 0.0001) - 0.0004) = 0.0002.
  // Hyperliquid perSide: taker 0.00155, maker 0.00035.
  //   net taker = 0.0002 + 0.05 - 0.0031 = 0.0471, net maker = 0.0002 + 0.05 - 0.0007 = 0.0495.
  const ep: SpreadEpisode = { level: 0.001, sign: 1, entryT: h(0), exitT: h(24), truncated: false };
  const baseEvents: FundingEvent[] = [
    { t: h(0), rate: 0.0005 },
    { t: h(8), rate: 0.0004 },
    { t: h(32), rate: 0.0009 },
  ];
  const otherEvents: FundingEvent[] = [
    { t: h(0), rate: 0.0009 },
    { t: h(8), rate: 0.0002 },
    { t: h(16), rate: 0.0003 },
    { t: h(24), rate: 0.0001 },
    { t: h(32), rate: 0.0009 },
  ];
  const flat = (open: number): HyperliquidCandle => ({ open, high: open, low: open, close: open });
  function perpFlat(): Map<number, KlineCsvRow> {
    const entries: Array<[number, KlineCsvRow]> = [];
    for (let i = 0; i < 24; i++) entries.push(bar(h(i), 100));
    entries.push(bar(h(24), 103));
    return new Map(entries);
  }
  function candles(): Map<number, HyperliquidCandle> {
    return new Map([
      [h(0), flat(50)],
      [h(8), flat(50)],
      [h(16), flat(50)],
      [h(24), flat(49)],
    ]);
  }
  const costs = VENUE_COSTS.hyperliquid;

  it('measures sign +1 from traded opens', () => {
    const m = measureSpreadEpisodeReal(ep, baseEvents, otherEvents, perpFlat(), candles(), costs);
    expect(m.status).toBe('ok');
    expect(m.priceSource).toBe('real');
    expect(m.missingBars).toBe(0);
    expect(m.grossFunding).toBeCloseTo(0.0002, 12);
    expect(m.basisApprox).toBeCloseTo(0.05, 12);
    expect(m.net?.taker).toBeCloseTo(0.0471, 12);
    expect(m.net?.maker).toBeCloseTo(0.0495, 12);
    expect(m.net?.['taker+10bps']).toBeCloseTo(0.0002 + 0.05 - 2 * 0.00355, 12);
    expect(m.holdHours).toBe(24);
    expect(m.otherEventsCollected).toBe(3);
    expect(m.baseEventsCollected).toBe(1);
    expect(m.worstLeg).toBe(0);
    expect(m.liquidated).toEqual({ '1x': false, '2x': false, '3x': false });
  });

  it('flips funding and basis for sign -1', () => {
    const m = measureSpreadEpisodeReal({ ...ep, sign: -1 }, baseEvents, otherEvents, perpFlat(), candles(), costs);
    expect(m.grossFunding).toBeCloseTo(-0.0002, 12);
    expect(m.basisApprox).toBeCloseTo(-0.05, 12);
    expect(m.net?.taker).toBeCloseTo(-0.0002 - 0.05 - 0.0031, 12);
  });

  it('returns no-price when a Hyperliquid candle at the exit is missing', () => {
    const missing = candles();
    missing.delete(h(24));
    const m = measureSpreadEpisodeReal(ep, baseEvents, otherEvents, perpFlat(), missing, costs);
    expect(m.status).toBe('no-price');
    expect(m.net).toBeNull();
    expect(m.basisApprox).toBeNull();
  });

  it('returns no-price when a Binance open at the entry or exit is missing', () => {
    const noEntry = perpFlat();
    noEntry.delete(h(0));
    expect(measureSpreadEpisodeReal(ep, baseEvents, otherEvents, noEntry, candles(), costs).status).toBe('no-price');
    const noExit = perpFlat();
    noExit.delete(h(24));
    expect(measureSpreadEpisodeReal(ep, baseEvents, otherEvents, noExit, candles(), costs).status).toBe('no-price');
  });

  it('returns gap when a path bar or a path candle is missing, and empty for a zero hold', () => {
    const noBar = perpFlat();
    noBar.delete(h(5));
    const gapBar = measureSpreadEpisodeReal(ep, baseEvents, otherEvents, noBar, candles(), costs);
    expect(gapBar.status).toBe('gap');
    expect(gapBar.missingBars).toBe(1);
    const noCandle = candles();
    noCandle.delete(h(8));
    const gapCandle = measureSpreadEpisodeReal(ep, baseEvents, otherEvents, perpFlat(), noCandle, costs);
    expect(gapCandle.status).toBe('gap');
    expect(gapCandle.missingBars).toBe(1);
    expect(
      measureSpreadEpisodeReal({ ...ep, exitT: ep.entryT }, baseEvents, otherEvents, perpFlat(), candles(), costs).status
    ).toBe('empty');
  });

  it('liquidates on a Hyperliquid candle high of twice the entry open while the Binance bars stay flat', () => {
    const spiky = candles();
    spiky.set(h(8), { open: 50, high: 100, low: 50, close: 50 });
    const m = measureSpreadEpisodeReal(ep, baseEvents, otherEvents, perpFlat(), spiky, costs);
    expect(m.status).toBe('ok');
    expect(m.upMove).toBeCloseTo(1, 12);
    expect(m.downMove).toBeCloseTo(0, 12);
    expect(m.worstLeg).toBeCloseTo(1, 12);
    expect(m.liquidated).toEqual({ '1x': true, '2x': true, '3x': true });
  });

  it('liquidates on a Hyperliquid low only when it halves the entry open', () => {
    const dip = candles();
    dip.set(h(16), { open: 50, high: 50, low: 20, close: 50 });
    const m = measureSpreadEpisodeReal(ep, baseEvents, otherEvents, perpFlat(), dip, costs);
    expect(m.downMove).toBeCloseTo(0.6, 12);
    expect(m.liquidated).toEqual({ '1x': false, '2x': true, '3x': true });
  });
});

describe('venueSlotBook', () => {
  function row(partial: Partial<VenueSlotRow>): VenueSlotRow {
    return {
      symbol: 'A',
      level: 0.001,
      entryT: h(0),
      exitT: h(10),
      status: 'ok',
      truncated: false,
      net: { taker: 0.01, maker: 0.02 },
      worstLeg: 0.1,
      ...partial,
    };
  }
  const spanFrom = Date.UTC(2023, 0, 1);
  const spanTo = spanFrom + 730 * 24 * HOUR_MS;

  // 2 slots, capital 2 x 2 = 4, span exactly 2 years.
  //   A hours 0..100 into slot 0 (net 0.04), B hours 10..50 into slot 1 (net 0.02).
  //   C hours 20..60: slots free at 100 and 50, both busy at 20: skipped.
  //   D hours 70..120: slot 1 (free at 50) is the earliest: taken (net -0.01).
  //   taken 3 of 4 eligible, totalNet 0.05, annual 0.05 / 4 / 2 = 0.00625, byYear 2023 return 0.05 / 4 = 0.0125.
  //   slotUse = (100 + 40 + 50) h / (2 slots x 730 x 24 h).
  //   C worstLeg 0.996 >= 1 - 0.005 counts as one 1x liquidation (eligible rows, as in slotBook).
  const rows: VenueSlotRow[] = [
    row({ symbol: 'A', entryT: h(0), exitT: h(100), net: { taker: 0.04, maker: 0.05 } }),
    row({ symbol: 'B', entryT: h(10), exitT: h(50), net: { taker: 0.02, maker: 0.03 } }),
    row({ symbol: 'C', entryT: h(20), exitT: h(60), net: { taker: 0.1, maker: 0.1 }, worstLeg: 0.996 }),
    row({ symbol: 'D', entryT: h(70), exitT: h(120), net: { taker: -0.01, maker: 0 } }),
  ];

  it('takes rows first come first served and skips the overlapping one', () => {
    const r = venueSlotBook(rows, 2, 0.001, spanFrom, spanTo);
    expect(r.eligible).toBe(4);
    expect(r.taken).toBe(3);
    expect(r.totalNet).toBeCloseTo(0.05, 12);
    expect(r.annualReturnOnCapital).toBeCloseTo(0.00625, 12);
    expect(r.slotUse).toBeCloseTo(190 / (2 * 730 * 24), 12);
    expect(r.perpLiquidations1x).toBe(1);
    expect(r.byYear['2023'].n).toBe(3);
    expect(r.byYear['2023'].sumNet).toBeCloseTo(0.05, 12);
    expect(r.byYear['2023'].returnOnCapital).toBeCloseTo(0.0125, 12);
  });

  it('uses the net of the named profile and a custom capital per unit', () => {
    const r = venueSlotBook(rows, 2, 0.001, spanFrom, spanTo, 1, 'maker');
    // A and B and D are taken: 0.05 + 0.03 + 0 = 0.08, capital 2 x 1 = 2, 2 years.
    expect(r.profile).toBe('maker');
    expect(r.totalNet).toBeCloseTo(0.08, 12);
    expect(r.annualReturnOnCapital).toBeCloseTo(0.08 / 2 / 2, 12);
  });

  it('ignores other levels, truncated rows, non-ok statuses and rows without a net', () => {
    const noise: VenueSlotRow[] = [
      row({ symbol: 'L', level: 0.002 }),
      row({ symbol: 'T', truncated: true }),
      row({ symbol: 'G', status: 'gap', net: null }),
      row({ symbol: 'P', status: 'no-price', net: null }),
      row({ symbol: 'N', net: null }),
    ];
    const r = venueSlotBook([...noise, ...rows], 2, 0.001, spanFrom, spanTo);
    expect(r.eligible).toBe(4);
    expect(r.taken).toBe(3);
    expect(r.totalNet).toBeCloseTo(0.05, 12);
  });
});

describe('summariseSpread', () => {
  const costNet = (taker: number): Record<string, number> => ({ taker, maker: taker + 0.001, 'taker+10bps': taker - 0.002 });
  function ep(partial: Partial<MeasuredSpreadEpisode>): MeasuredSpreadEpisode {
    return {
      level: 0.001,
      sign: 1,
      entryT: Date.UTC(2023, 5, 1),
      exitT: Date.UTC(2023, 5, 2),
      truncated: false,
      symbol: 'X',
      status: 'ok',
      missingBars: 0,
      grossFunding: 0.004,
      basisApprox: 0.001,
      upMove: 0.1,
      downMove: 0.1,
      worstLeg: 0.1,
      liquidated: { '2x': false, '3x': false },
      holdHours: 24,
      otherEventsCollected: 24,
      baseEventsCollected: 3,
      net: costNet(0.003),
      ...partial,
    };
  }

  it('counts every status and summarises only complete, non-truncated episodes', () => {
    const episodes = [
      ep({ liquidated: { '2x': false, '3x': true } }),
      ep({
        symbol: 'Y',
        status: 'no-premium',
        basisApprox: null,
        entryT: Date.UTC(2024, 1, 1),
        net: costNet(-0.001),
      }),
      ep({ net: costNet(0.005) }),
      ep({ truncated: true, net: costNet(9) }),
      ep({ status: 'gap', net: null }),
    ];
    const s = summariseSpread('hyperliquid', 0.001, episodes);
    expect(s.counts).toEqual({ total: 5, ok: 2, noPremium: 1, gap: 1, empty: 0, truncated: 1 });
    expect(s.noPremium).toBe(1);
    expect(s.distinctSymbols).toBe(2);
    expect(s.net.taker.mean).toBeCloseTo(0.007 / 3, 12);
    expect(s.net.taker.median).toBeCloseTo(0.003, 12);
    expect(s.net.taker.shareNetPositive).toBeCloseTo(2 / 3, 12);
    expect(s.net.maker.mean).toBeCloseTo(0.007 / 3 + 0.001, 12);
    expect(s.basisApprox.mean).toBeCloseTo(0.001, 12);
    expect(s.liquidationShare['3x']).toBeCloseTo(1 / 3, 12);
    expect(s.liquidationShare['2x']).toBe(0);
    expect(s.byYear['2023'].n).toBe(2);
    expect(s.byYear['2023'].sumNetTaker).toBeCloseTo(0.008, 12);
    expect(s.byYear['2024'].n).toBe(1);
    expect(s.top10Share).toBeCloseTo(1, 12);
  });

  it('returns nulls for an empty set', () => {
    const s = summariseSpread('bybit', 0.002, []);
    expect(s.net.taker.mean).toBeNull();
    expect(s.liquidationShare['3x']).toBeNull();
    expect(s.top10Share).toBeNull();
  });
});

describe('parsers', () => {
  const H = Date.UTC(2024, 5, 30, 22);

  it('parses Hyperliquid funding: rounds to the hour, drops the cutoff, dedupes (last wins), sorts', () => {
    const json = [
      { coin: 'BTC', fundingRate: '0.0000125', premium: '0.0004', time: H + 4 },
      { coin: 'BTC', fundingRate: '0.00002', premium: '0.0005', time: H - 2 },
      { coin: 'BTC', fundingRate: '0.00003', premium: '0.0006', time: H + HOUR_MS + 3 },
      { coin: 'BTC', fundingRate: '0.0009', premium: '0.0009', time: Date.UTC(2024, 5, 30, 23, 59, 59, 999) },
      { coin: 'BTC', fundingRate: '0.0009', premium: '0.0009', time: Date.UTC(2024, 6, 1, 0, 0, 0, 5) },
      { coin: 'BTC', fundingRate: '0.00001', premium: '0.0001', time: H - HOUR_MS + 1 },
    ];
    expect(parseHyperliquidFunding(json)).toEqual([
      { t: H - HOUR_MS, rate: 0.00001, premium: 0.0001 },
      { t: H, rate: 0.00002, premium: 0.0005 },
      { t: H + HOUR_MS, rate: 0.00003, premium: 0.0006 },
    ]);
    expect(() => parseHyperliquidFunding({})).toThrow();
  });

  it('parses Bybit funding: newest first becomes ascending, cutoff dropped, duplicate hour keeps the last in input order', () => {
    const row = (ts: number, rate: string) => ({ symbol: 'BTCUSDT', fundingRate: rate, fundingRateTimestamp: String(ts) });
    const json = {
      retCode: 0,
      retMsg: 'OK',
      result: {
        list: [
          row(Date.UTC(2024, 6, 1, 0), '0.0003'),
          row(Date.UTC(2024, 5, 30, 16) + 3, '0.00025'),
          row(Date.UTC(2024, 5, 30, 16), '0.0002'),
          row(Date.UTC(2024, 5, 30, 8), '0.0001'),
        ],
      },
    };
    expect(parseBybitFunding(json)).toEqual([
      { t: Date.UTC(2024, 5, 30, 8), rate: 0.0001 },
      { t: Date.UTC(2024, 5, 30, 16), rate: 0.0002 },
    ]);
    expect(() => parseBybitFunding({ retCode: 10001, retMsg: 'bad', result: {} })).toThrow(/retCode 10001/);
  });

  it('parses Bybit premium klines: bar open to close, cutoff dropped', () => {
    const json = {
      retCode: 0,
      result: {
        list: [
          [String(Date.UTC(2024, 6, 1, 0)), '0', '0', '0', '0.0009'],
          [String(H), '0.0006', '0.0008', '0.0005', '0.0007'],
          [String(H - HOUR_MS), '0.0005', '0.0007', '0.0004', '0.0006'],
        ],
      },
    };
    expect([...parseBybitPremium(json)]).toEqual([
      [H, 0.0007],
      [H - HOUR_MS, 0.0006],
    ]);
  });

  it('parses Hyperliquid 8h candles: keyed by open time, numbers, last repeat wins, cutoff dropped, non-array throws', () => {
    const a = Date.UTC(2024, 5, 30, 0);
    const row = (t: number, o: string, c: string, hi: string, lo: string) => ({
      t,
      T: t + 8 * HOUR_MS - 1,
      s: 'BTC',
      i: '8h',
      o,
      c,
      h: hi,
      l: lo,
      v: '5',
      n: 3,
    });
    const json = [
      row(a, '100', '101', '102', '99'),
      row(a + 8 * HOUR_MS, '101', '103', '104', '100.5'),
      row(a, '110', '111', '112', '109'),
      row(SCOUT_CUTOFF_MS, '1', '1', '1', '1'),
    ];
    const map = parseHyperliquidCandles(json);
    expect([...map.keys()]).toEqual([a, a + 8 * HOUR_MS]);
    expect(map.get(a)).toEqual({ open: 110, high: 112, low: 109, close: 111 });
    expect(map.get(a + 8 * HOUR_MS)).toEqual({ open: 101, high: 104, low: 100.5, close: 103 });
    expect(map.has(SCOUT_CUTOFF_MS)).toBe(false);
    expect(() => parseHyperliquidCandles({})).toThrow();
  });

  it('parses the Hyperliquid meta list and Bybit instruments', () => {
    expect(parseHyperliquidMeta({ universe: [{ name: 'BTC' }, { name: 'kPEPE' }, { name: 'OLD', isDelisted: true }] })).toEqual([
      'BTC',
      'kPEPE',
      'OLD',
    ]);
    const page = {
      retCode: 0,
      result: {
        nextPageCursor: 'abc',
        list: [
          { symbol: 'BTCUSDT', quoteCoin: 'USDT', contractType: 'LinearPerpetual' },
          { symbol: 'BTCUSDC', quoteCoin: 'USDC', contractType: 'LinearPerpetual' },
          { symbol: 'BTCUSDT-26DEC25', quoteCoin: 'USDT', contractType: 'LinearFutures' },
        ],
      },
    };
    expect(parseBybitInstruments(page)).toEqual({ symbols: ['BTCUSDT'], nextCursor: 'abc' });
  });
});

describe('coin mapping', () => {
  it('maps Binance folders to Hyperliquid coins', () => {
    const listed = new Set(['BTC', 'kPEPE', 'PEPE', 'MOG']);
    expect(hyperliquidCoinFor('BTCUSDT', listed)).toBe('BTC');
    expect(hyperliquidCoinFor('1000PEPEUSDT', listed)).toBe('kPEPE');
    expect(hyperliquidCoinFor('1000000MOGUSDT', listed)).toBe('MOG');
    expect(hyperliquidCoinFor('DOGEUSDT', listed)).toBeNull();
    expect(hyperliquidCoinFor('1000PEPEUSDT', new Set(['PEPE']))).toBe(null);
  });
  it('maps Binance folders to Bybit symbols with the 1000 fallback', () => {
    const listed = new Set(['BTCUSDT', 'PEPE1000USDT', '1000BONKUSDT']);
    expect(bybitSymbolFor('BTCUSDT', listed)).toBe('BTCUSDT');
    expect(bybitSymbolFor('1000PEPEUSDT', listed)).toBe('PEPE1000USDT');
    expect(bybitSymbolFor('1000BONKUSDT', listed)).toBe('1000BONKUSDT');
    expect(bybitSymbolFor('XYZUSDT', listed)).toBeNull();
  });
});

describe('data discipline and args', () => {
  it('refuses a request end at or after the cutoff', () => {
    expect(() => assertEndAllowed(SCOUT_CUTOFF_MS)).toThrow(/data discipline/);
    expect(() => assertEndAllowed(SCOUT_CUTOFF_MS - 1)).not.toThrow();
    expect(() => hyperliquidFundingBody('BTC', SCOUT_FROM_MS, SCOUT_CUTOFF_MS)).toThrow(/data discipline/);
    expect(() => bybitFundingUrl('BTCUSDT', SCOUT_FROM_MS, SCOUT_CUTOFF_MS)).toThrow(/data discipline/);
    expect(() => bybitPremiumUrl('BTCUSDT', SCOUT_FROM_MS, SCOUT_CUTOFF_MS + 1)).toThrow(/data discipline/);
  });
  it('builds request shapes with the capped end', () => {
    expect(hyperliquidFundingBody('BTC', SCOUT_FROM_MS, SCOUT_CUTOFF_MS - 1)).toEqual({
      type: 'fundingHistory',
      coin: 'BTC',
      startTime: SCOUT_FROM_MS,
      endTime: SCOUT_CUTOFF_MS - 1,
    });
    const url = bybitFundingUrl('BTCUSDT', SCOUT_FROM_MS, SCOUT_CUTOFF_MS - 1);
    expect(url).toContain('category=linear');
    expect(url).toContain('limit=200');
    expect(url).toContain(`endTime=${SCOUT_CUTOFF_MS - 1}`);
  });
  it('builds the Hyperliquid candle body and refuses an end at the cutoff', () => {
    const start = Date.UTC(2023, 0, 1);
    expect(hyperliquidCandleBody('BTC', start, SCOUT_CUTOFF_MS - 1)).toEqual({
      type: 'candleSnapshot',
      req: { coin: 'BTC', interval: '8h', startTime: start, endTime: SCOUT_CUTOFF_MS - 1 },
    });
    expect(() => hyperliquidCandleBody('BTC', start, SCOUT_CUTOFF_MS)).toThrow(/data discipline/);
  });
  it('parses --price and keeps the default args unchanged', () => {
    const base = ['--universe', 'u.json', '--cache', 'c', '--out', 'o.json'];
    expect(parseArgs(['--venue', 'hyperliquid', ...base])).toEqual({
      venue: 'hyperliquid',
      universe: 'u.json',
      cache: 'c',
      out: 'o.json',
      coins: null,
    });
    expect(parseArgs(['--venue', 'hyperliquid', ...base, '--price', 'real']).price).toBe('real');
    expect(parseArgs(['--venue', 'hyperliquid', ...base, '--price', 'premium']).price).toBe('premium');
    expect(() => parseArgs(['--venue', 'bybit', ...base, '--price', 'real'])).toThrow(/--price real/);
    expect(() => parseArgs(['--venue', 'hyperliquid', ...base, '--price', 'mid'])).toThrow(/--price/);
  });
  it('parses args and rejects unknown flags and venues', () => {
    expect(parseArgs(['--venue', 'bybit', '--universe', 'u.json', '--cache', 'c', '--out', 'o.json', '--coins', 'A, B'])).toEqual({
      venue: 'bybit',
      universe: 'u.json',
      cache: 'c',
      out: 'o.json',
      coins: ['A', 'B'],
    });
    expect(() => parseArgs(['--venue', 'bybit', '--universe', 'u', '--cache', 'c', '--out', 'o', '--bogus', 'x'])).toThrow(
      /Unknown flag/
    );
    expect(() => parseArgs(['--venue', 'okx', '--universe', 'u', '--cache', 'c', '--out', 'o'])).toThrow(/--venue/);
    expect(() => parseArgs(['--venue', 'bybit', '--universe', 'u', '--cache', 'c'])).toThrow(/--out is required/);
  });
  it('keeps the spread levels and cost profile names stable', () => {
    expect(SPREAD_LEVELS).toEqual([0.001, 0.002, 0.005]);
    expect(VENUE_COSTS.hyperliquid.map((c) => c.name)).toEqual(['taker', 'maker', 'taker+10bps']);
    expect(VENUE_COSTS.bybit[0].perSide).toBeCloseTo(0.00165, 12);
  });
});
