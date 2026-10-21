import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KLineData } from 'klinecharts';
import {
  MAX_EVENTS,
  MAX_PIVOT_LABELS,
  formatFlow,
  makeCvdCalc,
  makeDeltaVolCalc,
  makeStructureCalc,
} from './focus-indicators';

const registerIndicator = vi.fn();
vi.mock('klinecharts', () => ({
  registerIndicator: (...args: unknown[]) => registerIndicator(...args),
}));

const HOUR = 3_600_000;

function makeCandles(
  bars: Array<{ high: number; low: number; close: number; open?: number; volume?: number; takerBuyVolume?: number }>
): KLineData[] {
  let prevClose = bars[0]?.close ?? 100;
  return bars.map((b, i) => {
    const open = b.open ?? (i === 0 ? b.close : prevClose);
    prevClose = b.close;
    return {
      timestamp: i * HOUR,
      open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume ?? 1000,
      ...(b.takerBuyVolume !== undefined ? { takerBuyVolume: b.takerBuyVolume } : {}),
    };
  });
}

function generateWalk(numBars: number, seed: number): KLineData[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };

  const candles: KLineData[] = [];
  let prevClose = 1000;
  for (let i = 0; i < numBars; i++) {
    const change = (rand() - 0.49) * 20;
    const open = prevClose;
    const close = Math.round((open + change) * 100) / 100;
    const maxOC = Math.max(open, close);
    const minOC = Math.min(open, close);
    const high = Math.round((maxOC + rand() * 10) * 100) / 100;
    const low = Math.round((minOC - rand() * 10) * 100) / 100;
    prevClose = close;
    candles.push({
      timestamp: i * HOUR,
      open,
      high,
      low,
      close,
      volume: 1000 + Math.floor(rand() * 500),
      takerBuyVolume: 500 + Math.floor(rand() * 300),
    });
  }
  return candles;
}

beforeEach(() => {
  registerIndicator.mockClear();
});

describe('makeStructureCalc', () => {
  it('puts the expected labels and events on the right indexes on a fixture', () => {
    // Build a fixture where swing length 20 produces confirmed pivots and a break
    const bars: Array<{ high: number; low: number; close: number }> = [];
    // 0..19: flat
    for (let i = 0; i < 20; i++) bars.push({ high: 80, low: 70, close: 75 });
    // 20: High 1 (100)
    bars.push({ high: 100, low: 75, close: 90 });
    // 21..39: flat (confirms High 1 at index 40)
    for (let i = 21; i < 40; i++) bars.push({ high: 80, low: 70, close: 75 });
    // 40: Low 1 (50)
    bars.push({ high: 75, low: 50, close: 60 });
    // 41..59: flat (confirms Low 1 at index 60)
    for (let i = 41; i < 60; i++) bars.push({ high: 80, low: 70, close: 75 });
    // 60: High 2 (120) -> HH relative to 100
    bars.push({ high: 120, low: 75, close: 110 });
    // 61..79: flat (confirms High 2 at index 80)
    for (let i = 61; i < 80; i++) bars.push({ high: 80, low: 70, close: 75 });
    // 80: Low 2 (60) -> HL relative to 50
    bars.push({ high: 75, low: 60, close: 70 });
    // 81..99: flat (confirms Low 2 at index 100)
    for (let i = 81; i < 100; i++) bars.push({ high: 80, low: 70, close: 75 });
    // 100: Breaks 120 -> BOS bull at index 100
    bars.push({ high: 130, low: 75, close: 125 });
    // 101..110: flat
    for (let i = 101; i <= 110; i++) bars.push({ high: 80, low: 70, close: 75 });

    const candles = makeCandles(bars);
    const calc = makeStructureCalc({
      intervalMs: HOUR,
      now: () => 200 * HOUR,
      showInternal: false,
    });
    const results = calc(candles);

    expect(results).toHaveLength(candles.length);
    // Index 60 has pivot high labeled HH
    expect(results[60].pivotLabel).toEqual({
      label: 'HH',
      kind: 'high',
    });
    // Index 80 has pivot low labeled HL
    expect(results[80].pivotLabel).toEqual({
      label: 'HL',
      kind: 'low',
    });
    // Index 100 has BOS bull event
    expect(results[100].events).toBeDefined();
    expect(results[100].events).toHaveLength(1);
    expect(results[100].events![0]).toEqual({
      type: 'BOS',
      direction: 'bull',
      level: 120,
      pivotIndex: 60,
      breakIndex: 100,
      latest: true,
    });
  });

  it('excludes a forming last bar when now is before its close', () => {
    const bars: Array<{ high: number; low: number; close: number }> = [];
    for (let i = 0; i < 20; i++) bars.push({ high: 80, low: 70, close: 75 });
    bars.push({ high: 100, low: 75, close: 90 }); // index 20
    for (let i = 21; i < 40; i++) bars.push({ high: 80, low: 70, close: 75 });
    // index 40: break bar, but unclosed
    bars.push({ high: 120, low: 75, close: 110 });

    const candles = makeCandles(bars);
    const lastBar = candles[candles.length - 1];

    // now is before the last bar's close: timestamp + HOUR = 41 * HOUR > now
    const calcForming = makeStructureCalc({
      intervalMs: HOUR,
      now: () => lastBar.timestamp + HOUR / 2,
    });
    const formingResults = calcForming(candles);
    expect(formingResults[candles.length - 1]).toEqual({});

    // now is after the last bar's close: last bar is included
    const calcClosed = makeStructureCalc({
      intervalMs: HOUR,
      now: () => lastBar.timestamp + HOUR,
    });
    const closedResults = calcClosed(candles);
    expect(closedResults).toHaveLength(candles.length);
  });

  it('holds clutter caps on a long random walk (at most 6 labels and 4 swing events)', () => {
    const walk = generateWalk(350, 42);
    const calc = makeStructureCalc({
      intervalMs: HOUR,
      now: () => 500 * HOUR,
      showInternal: true,
    });
    const results = calc(walk);

    const labels = results.filter((r) => r.pivotLabel);
    expect(labels.length).toBeLessThanOrEqual(MAX_PIVOT_LABELS);
    expect(labels.length).toBeGreaterThan(0);

    const swingEvents = results.flatMap((r) => r.events ?? []).filter((e) => !e.internal);
    expect(swingEvents.length).toBeLessThanOrEqual(MAX_EVENTS);
    expect(swingEvents.length).toBeGreaterThan(0);

    const internalEvents = results.flatMap((r) => r.events ?? []).filter((e) => e.internal);
    expect(internalEvents.length).toBeLessThanOrEqual(MAX_EVENTS);
    expect(internalEvents.length).toBeGreaterThan(0);
  });

  it('marks exactly one event with latest: true', () => {
    const walk = generateWalk(350, 42);
    const calc = makeStructureCalc({
      intervalMs: HOUR,
      now: () => 500 * HOUR,
      showInternal: true,
    });
    const results = calc(walk);

    const allEvents = results.flatMap((r) => r.events ?? []);
    const latestEvents = allEvents.filter((e) => e.latest === true);
    expect(latestEvents).toHaveLength(1);
    expect(latestEvents[0].internal).toBeFalsy();
  });

  it('includes internal marks only when showInternal is true', () => {
    const walk = generateWalk(300, 77);

    const calcWithoutInternal = makeStructureCalc({
      intervalMs: HOUR,
      now: () => 500 * HOUR,
      showInternal: false,
    });
    const resWithout = calcWithoutInternal(walk);
    const internalWithout = resWithout.flatMap((r) => r.events ?? []).filter((e) => e.internal);
    expect(internalWithout).toHaveLength(0);

    const calcWithInternal = makeStructureCalc({
      intervalMs: HOUR,
      now: () => 500 * HOUR,
      showInternal: true,
    });
    const resWith = calcWithInternal(walk);
    const internalWith = resWith.flatMap((r) => r.events ?? []).filter((e) => e.internal);
    expect(internalWith.length).toBeGreaterThan(0);
    expect(internalWith.every((e) => e.internal === true)).toBe(true);
  });
});

describe('makeDeltaVolCalc', () => {
  it('gives winner buy, sell, even and null cases', () => {
    const candles = makeCandles([
      { high: 100, low: 90, close: 95, volume: 100, takerBuyVolume: 60 }, // delta = 20 > 0 -> buy
      { high: 100, low: 90, close: 95, volume: 100, takerBuyVolume: 40 }, // delta = -20 < 0 -> sell
      { high: 100, low: 90, close: 95, volume: 100, takerBuyVolume: 50 }, // delta = 0 -> even
      { high: 100, low: 90, close: 95, volume: 100 }, // missing takerBuyVolume -> null
    ]);

    const calc = makeDeltaVolCalc();
    const results = calc(candles);

    expect(results).toEqual([
      { volume: 100, delta: 20, winner: 'buy' },
      { volume: 100, delta: -20, winner: 'sell' },
      { volume: 100, delta: 0, winner: 'even' },
      { volume: 100, delta: null, winner: null },
    ]);
  });
});

describe('makeCvdCalc', () => {
  it('resets at a UTC midnight bar and gives null for a bar without takerBuyVolume', () => {
    const midnight = Date.UTC(2026, 9, 2, 0, 0, 0, 0);
    const candles: KLineData[] = [
      { timestamp: midnight - HOUR, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100, takerBuyVolume: 60 }, // delta = +20, cvd = 20
      { timestamp: midnight, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100, takerBuyVolume: 70 }, // midnight reset! delta = +40, cvd = 40
      { timestamp: midnight + HOUR, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }, // missing takerBuyVolume -> delta null, cvd null
      { timestamp: midnight + 2 * HOUR, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100, takerBuyVolume: 60 }, // delta = +20, cvd = 40 + 20 = 60
    ];

    const calc = makeCvdCalc();
    const results = calc(candles);

    expect(results).toEqual([
      { cvd: 20 },
      { cvd: 40 },
      { cvd: null },
      { cvd: 60 },
    ]);
  });
});

describe('ensureFocusIndicatorsRegistered', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function load() {
    return import('./focus-indicators');
  }

  it('registers STRUCTURE, DELTA_VOL and CVD indicators', async () => {
    const mod = await load();
    mod.ensureFocusIndicatorsRegistered();
    expect(registerIndicator).toHaveBeenCalledTimes(3);

    const names = registerIndicator.mock.calls.map((c) => c[0].name);
    expect(names).toContain(mod.STRUCTURE_INDICATOR);
    expect(names).toContain(mod.DELTA_VOL_INDICATOR);
    expect(names).toContain(mod.CVD_INDICATOR);
  });

  it('exports pane identifiers and heights', async () => {
    const mod = await load();
    expect(mod.DELTA_VOL_PANE_ID).toBe('delta_vol_pane');
    expect(mod.CVD_PANE_ID).toBe('cvd_pane');
    expect(mod.DELTA_VOL_PANE_HEIGHT).toBe(90);
    expect(mod.CVD_PANE_HEIGHT).toBe(80);
  });

  it('formats DELTA_VOL tooltip with Vol and signed Delta or n/a', async () => {
    const mod = await load();
    mod.ensureFocusIndicatorsRegistered();
    const deltaVolRegistration = registerIndicator.mock.calls.find(
      (c) => c[0].name === mod.DELTA_VOL_INDICATOR
    )?.[0];
    const { createTooltipDataSource } = deltaVolRegistration;

    const buyResult = createTooltipDataSource({
      indicator: { result: [{ volume: 3474, delta: -299.38300000000027, winner: 'sell' }] },
      crosshair: { dataIndex: 0 },
    });
    expect(buyResult.legends).toHaveLength(2);
    expect(buyResult.legends[0].value.text).toBe('Vol 3,474');
    expect(buyResult.legends[1].value.text).toBe('Delta -299.38');
    expect(buyResult.legends[1].value.color).toBe(mod.FOCUS_COLORS.bearish);

    const posResult = createTooltipDataSource({
      indicator: { result: [{ volume: 100, delta: 25, winner: 'buy' }] },
      crosshair: { dataIndex: 0 },
    });
    expect(posResult.legends[0].value.text).toBe('Vol 100.00');
    expect(posResult.legends[1].value.text).toBe('Delta +25.00');
    expect(posResult.legends[1].value.color).toBe(mod.FOCUS_COLORS.bullish);

    const nullResult = createTooltipDataSource({
      indicator: { result: [{ volume: 100, delta: null, winner: null }] },
      crosshair: { dataIndex: 0 },
    });
    expect(nullResult.legends[0].value.text).toBe('Vol 100.00');
    expect(nullResult.legends[1].value.text).toBe('Delta n/a');
    expect(nullResult.legends[1].value.color).toBe(mod.FOCUS_COLORS.muted);
  });

  it('formats CVD tooltip with resets 00:00 UTC and value or n/a', async () => {
    const mod = await load();
    mod.ensureFocusIndicatorsRegistered();
    const cvdRegistration = registerIndicator.mock.calls.find(
      (c) => c[0].name === mod.CVD_INDICATOR
    )?.[0];
    const { createTooltipDataSource } = cvdRegistration;

    const valResult = createTooltipDataSource({
      indicator: { result: [{ cvd: 6146.844000000001 }] },
      crosshair: { dataIndex: 0 },
    });
    expect(valResult.legends).toHaveLength(1);
    expect(valResult.legends[0].value.text).toBe('CVD (resets 00:00 UTC) 6,147');

    const nullResult = createTooltipDataSource({
      indicator: { result: [{ cvd: null }] },
      crosshair: { dataIndex: 0 },
    });
    expect(nullResult.legends[0].value.text).toBe('CVD (resets 00:00 UTC) n/a');
  });

  it('draws prior-day levels, pivot labels and events on price pane', async () => {
    const mod = await load();
    mod.ensureFocusIndicatorsRegistered();
    const structureRegistration = registerIndicator.mock.calls.find(
      (c) => c[0].name === mod.STRUCTURE_INDICATOR
    )?.[0];
    const { draw } = structureRegistration;

    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn(),
      setLineDash: vi.fn(),
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 0,
      font: '',
      textAlign: '',
      textBaseline: '',
    };

    const dataList = [
      { timestamp: 0, open: 100, high: 110, low: 90, close: 105, volume: 100 },
      { timestamp: HOUR, open: 105, high: 120, low: 100, close: 115, volume: 100 },
    ];
    const results = [
      { pivotLabel: { label: 'HH' as const, kind: 'high' as const } },
      {
        events: [
          { type: 'BOS' as const, direction: 'bull' as const, level: 110, pivotIndex: 0, breakIndex: 1, latest: true },
          { type: 'BOS' as const, direction: 'bear' as const, level: 95, pivotIndex: 0, breakIndex: 1, internal: true },
        ],
      },
    ];

    const covered = draw({
      ctx,
      chart: { getDataList: () => dataList },
      indicator: {
        result: results,
        extendData: { priorDay: { high: 125, low: 85, close: 110 } },
      },
      bounding: { width: 800, height: 400 },
      xAxis: { convertToPixel: (i: number) => i * 100 },
      yAxis: { convertToPixel: (v: number) => 500 - v },
    });

    expect(covered).toBe(false);
    // Prior-day lines text
    expect(ctx.fillText).toHaveBeenCalledWith('Prior-day high', 796, expect.any(Number));
    expect(ctx.fillText).toHaveBeenCalledWith('Prior-day low', 796, expect.any(Number));
    expect(ctx.fillText).toHaveBeenCalledWith('Prior-day close', 796, expect.any(Number));
    // Pivot label
    expect(ctx.fillText).toHaveBeenCalledWith('HH', 0, expect.any(Number));
    // Swing BOS event text
    expect(ctx.fillText).toHaveBeenCalledWith('BOS', 50, expect.any(Number));
    // Internal event setLineDash [2, 2]
    expect(ctx.setLineDash).toHaveBeenCalledWith([2, 2]);
  });
});

describe('formatFlow', () => {
  it('formats |value| >= 1000 with no decimals and thousands separators (en-US)', () => {
    expect(formatFlow(6146.844000000001)).toBe('6,147');
    expect(formatFlow(1000)).toBe('1,000');
    expect(formatFlow(-1000)).toBe('-1,000');
    expect(formatFlow(-6146.844000000001)).toBe('-6,147');
  });

  it('formats |value| >= 1 with 2 decimals', () => {
    expect(formatFlow(-299.38300000000027)).toBe('-299.38');
    expect(formatFlow(1)).toBe('1.00');
    expect(formatFlow(2.5)).toBe('2.50');
    expect(formatFlow(-2.5)).toBe('-2.50');
    expect(formatFlow(999.99)).toBe('999.99');
  });

  it('formats |value| < 1 with 4 decimals', () => {
    expect(formatFlow(0.000123)).toBe('0.0001');
    expect(formatFlow(0.00005)).toBe('0.0001');
    expect(formatFlow(0.5)).toBe('0.5000');
    expect(formatFlow(-0.000123)).toBe('-0.0001');
    expect(formatFlow(0)).toBe('0.0000');
  });

  it('keeps sign and adds leading + for positive numbers when signed option is true', () => {
    expect(formatFlow(2.5, { signed: true })).toBe('+2.50');
    expect(formatFlow(-2.5, { signed: true })).toBe('-2.50');
    expect(formatFlow(6146.8, { signed: true })).toBe('+6,147');
    expect(formatFlow(-299.38300000000027, { signed: true })).toBe('-299.38');
    expect(formatFlow(0.000123, { signed: true })).toBe('+0.0001');
    expect(formatFlow(0, { signed: true })).toBe('0.0000');
  });
});
