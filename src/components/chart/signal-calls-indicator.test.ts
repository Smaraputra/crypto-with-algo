import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KLineData } from 'klinecharts';

import type { CallMark } from '@/lib/signals/track-record/chart-data';

const registerIndicator = vi.fn();
vi.mock('klinecharts', () => ({
  registerIndicator: (...args: unknown[]) => registerIndicator(...args),
}));

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);
const kline = (i: number): KLineData => ({ timestamp: T0 + i * HOUR, open: 100, high: 110, low: 90, close: 100 + i });

const call = (over: Partial<CallMark> = {}): CallMark => ({
  t: T0,
  dir: 1,
  outcome: 'won',
  source: 'rescore',
  score: 31.25,
  tier: 'buy',
  fwd: 0.5,
  ...over,
});

async function load() {
  vi.resetModules();
  return import('./signal-calls-indicator');
}

beforeEach(() => {
  registerIndicator.mockClear();
});

describe('describeCall', () => {
  it('states the side, the source, the move and the result after costs', async () => {
    const { describeCall } = await load();
    expect(describeCall(call(), 24, 0.16)).toBe(
      'Buy call (Long score) · re-scored, not live · score 31.3 · price +0.50% over 24 bars · +0.34% after 0.16% costs · won after costs'
    );
    expect(describeCall(call({ dir: -1, tier: 'strong_sell', score: -40, fwd: -0.1, outcome: 'cost', source: 'live' }), 24, 0.16)).toBe(
      'Sell call (Strong short score) · live record · score -40.0 · price -0.10% over 24 bars · -0.06% after 0.16% costs · right, but costs ate it'
    );
    expect(describeCall(call({ fwd: -0.3, outcome: 'wrong' }), 12, 0.2)).toContain('-0.50% after 0.20% costs · wrong way');
  });

  it('says pending when the outcome is not known yet', async () => {
    const { describeCall } = await load();
    expect(describeCall(call({ fwd: null, outcome: 'pending', source: 'live' }), 24, 0.16)).toBe(
      'Buy call (Long score) · live record · score 31.3 · outcome pending'
    );
  });
});

describe('makeSignalCallsCalc', () => {
  it('puts each call on its own bar with its tooltip and leaves the others empty', async () => {
    const { makeSignalCallsCalc } = await load();
    const calls = new Map([[T0 + HOUR, call({ t: T0 + HOUR })]]);
    const out = makeSignalCallsCalc({ calls, horizonBars: 24, costPercent: 0.16 })([kline(0), kline(1), kline(2)]);
    expect(out[0]).toEqual({});
    expect(out[1].call?.t).toBe(T0 + HOUR);
    expect(out[1].tip).toContain('Buy call');
    expect(out[2]).toEqual({});
  });

  it('returns a new function every call, so overrideIndicator recalculates', async () => {
    const { makeSignalCallsCalc } = await load();
    const snap = { calls: new Map(), horizonBars: 24, costPercent: 0.16 };
    expect(makeSignalCallsCalc(snap)).not.toBe(makeSignalCallsCalc(snap));
  });
});

function fakeCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    fillText: vi.fn(),
    setLineDash: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    textBaseline: '',
  };
}

async function drawWith(results: Array<{ call?: CallMark }>, extend: Record<string, unknown>, dataLength = 40) {
  const mod = await load();
  mod.ensureSignalCallsIndicatorRegistered();
  const template = registerIndicator.mock.calls[0][0];
  const ctx = fakeCtx();
  const dataList = Array.from({ length: dataLength }, (_, i) => kline(i));
  const covered = template.draw({
    ctx,
    chart: {
      getDataList: () => dataList,
      getVisibleRange: () => ({ from: 0, to: dataLength }),
      getBarSpace: () => ({ bar: 8 }),
    },
    indicator: { result: results, extendData: extend },
    bounding: { width: 800, height: 400 },
    xAxis: { convertToPixel: (i: number) => i * 10, convertTimestampToPixel: (t: number) => ((t - T0) / HOUR) * 10 },
    yAxis: { convertToPixel: (v: number) => 500 - v },
  });
  return { ctx, covered, template };
}

describe('ensureSignalCallsIndicatorRegistered', () => {
  it('registers a price-pane indicator once', async () => {
    const mod = await load();
    mod.ensureSignalCallsIndicatorRegistered();
    mod.ensureSignalCallsIndicatorRegistered();
    expect(registerIndicator).toHaveBeenCalledTimes(1);
    expect(registerIndicator.mock.calls[0][0]).toMatchObject({ name: mod.SIGNAL_CALLS_INDICATOR, series: 'price', figures: [] });
  });

  it('fills a triangle per call in its outcome colour and outlines pending ones', async () => {
    const results: Array<{ call?: CallMark }> = Array.from({ length: 40 }, () => ({}));
    results[2] = { call: call({ t: T0 + 2 * HOUR }) };
    results[5] = { call: call({ t: T0 + 5 * HOUR, dir: -1, outcome: 'wrong' }) };
    results[7] = { call: call({ t: T0 + 7 * HOUR, outcome: 'pending', fwd: null }) };
    const { ctx, covered } = await drawWith(results, { boundary: null, hover: null, horizonBars: 24 });
    expect(covered).toBe(false);
    expect(ctx.fill).toHaveBeenCalledTimes(2);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
    // buy tip under the low (90 -> y 410) plus the gap; sell tip over the high (110 -> y 390) minus the gap
    expect(ctx.moveTo).toHaveBeenCalledWith(20, 413);
    expect(ctx.moveTo).toHaveBeenCalledWith(50, 387);
  });

  it('draws the hand-over line with both labels when the boundary is loaded', async () => {
    const { ctx } = await drawWith([], { boundary: T0 + 10 * HOUR, hover: null, horizonBars: 24 });
    expect(ctx.setLineDash).toHaveBeenCalledWith([4, 4]);
    expect(ctx.fillText).toHaveBeenCalledWith('re-scored', expect.any(Number), 396);
    expect(ctx.fillText).toHaveBeenCalledWith('live record', expect.any(Number), 396);
  });

  it('skips the hand-over line when the boundary lies outside the loaded bars', async () => {
    const { ctx } = await drawWith([], { boundary: T0 + 1_000 * HOUR, hover: null, horizonBars: 24 });
    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it('draws the hovered call from its close to the close it was judged on', async () => {
    const results: Array<{ call?: CallMark }> = Array.from({ length: 40 }, () => ({}));
    results[3] = { call: call({ t: T0 + 3 * HOUR, fwd: 0.42 }) };
    const { ctx } = await drawWith(results, { boundary: null, hover: T0 + 3 * HOUR, horizonBars: 24 });
    // entry close 103 at x 30, exit close 127 at x 270
    expect(ctx.moveTo).toHaveBeenCalledWith(30, 397);
    expect(ctx.lineTo).toHaveBeenCalledWith(270, 373);
    expect(ctx.fillText).toHaveBeenCalledWith('+0.42%', 275, 370);
  });

  it('draws no span when the judged bar is not loaded yet', async () => {
    const results: Array<{ call?: CallMark }> = Array.from({ length: 40 }, () => ({}));
    results[30] = { call: call({ t: T0 + 30 * HOUR }) };
    const { ctx } = await drawWith(results, { boundary: null, hover: T0 + 30 * HOUR, horizonBars: 24 });
    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it('shows the hovered call in the tooltip in its outcome colour', async () => {
    const mod = await load();
    mod.ensureSignalCallsIndicatorRegistered();
    const { createTooltipDataSource } = registerIndicator.mock.calls[0][0];
    const c = call({ outcome: 'wrong', fwd: -1 });
    const out = createTooltipDataSource({ indicator: { result: [{ call: c, tip: 'tip text' }] }, crosshair: { dataIndex: 0 } });
    expect(out.legends).toEqual([{ title: '', value: { text: 'tip text', color: mod.CALL_COLORS.wrong } }]);
    const none = createTooltipDataSource({ indicator: { result: [{}] }, crosshair: { dataIndex: 0 } });
    expect(none.legends).toEqual([]);
  });
});
