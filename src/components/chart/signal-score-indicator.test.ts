import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KLineData } from 'klinecharts';
import type { ProvisionalScore } from '@/lib/signals/provisional/types';

const registerIndicator = vi.fn();
vi.mock('klinecharts', () => ({
  registerIndicator: (...args: unknown[]) => registerIndicator(...args),
}));

const T0 = Date.UTC(2026, 9, 9, 5, 0, 0, 0);
const HOUR = 3_600_000;
const kline = (timestamp: number): KLineData => ({ timestamp, open: 1, high: 1, low: 1, close: 1 });
const klines = [T0 - 2 * HOUR, T0 - HOUR, T0].map(kline);

const provisional: ProvisionalScore = {
  openTime: T0,
  score: -12.5,
  tier: 'neutral',
  confidence: 61.2,
  components: [],
};
const recorded = new Map([
  [T0 - 2 * HOUR, { score: 30, tier: 'buy' as const, confidence: 80, configVersion: 8 }],
  [T0 - HOUR, { score: -40, tier: 'sell' as const, confidence: 70.5, configVersion: 8 }],
]);

async function load() {
  vi.resetModules();
  return import('./signal-score-indicator');
}

beforeEach(() => {
  registerIndicator.mockClear();
});

describe('makeSignalScoreCalc', () => {
  it('fills recorded values by timestamp and leaves the rest empty', async () => {
    const { makeSignalScoreCalc } = await load();
    const out = makeSignalScoreCalc({ recorded, provisional: null, state: null })(klines) as Array<Record<string, unknown>>;
    expect(out.map((d) => d.recorded)).toEqual([30, -40, undefined]);
    expect(out.map((d) => d.provisional)).toEqual([undefined, undefined, undefined]);
  });

  it('puts the provisional score only on the matching bar while provisional', async () => {
    const { makeSignalScoreCalc } = await load();
    const out = makeSignalScoreCalc({ recorded, provisional, state: 'provisional' })(klines) as Array<Record<string, unknown>>;
    expect(out.map((d) => d.provisional)).toEqual([undefined, undefined, -12.5]);
    expect(out[2].recorded).toBeUndefined();
  });

  it('keeps the closed bar value while awaiting the record', async () => {
    const { makeSignalScoreCalc } = await load();
    const out = makeSignalScoreCalc({ recorded, provisional, state: 'awaiting-record' })(klines) as Array<Record<string, unknown>>;
    expect(out[2].provisional).toBe(-12.5);
  });

  it('draws no provisional value without a state or without a matching bar', async () => {
    const { makeSignalScoreCalc } = await load();
    const noState = makeSignalScoreCalc({ recorded, provisional, state: null })(klines) as Array<Record<string, unknown>>;
    expect(noState.every((d) => d.provisional === undefined)).toBe(true);
    const other = makeSignalScoreCalc({
      recorded, provisional: { ...provisional, openTime: T0 + HOUR }, state: 'provisional',
    })(klines) as Array<Record<string, unknown>>;
    expect(other.every((d) => d.provisional === undefined)).toBe(true);
  });

  it('draws re-scored values only where no recorded score exists, labelled as hindsight', async () => {
    const { makeSignalScoreCalc } = await load();
    const rescored = new Map([
      [T0 - 2 * HOUR, { score: 99, tier: 'strong_buy' as const }],
      [T0, { score: -31, tier: 'sell' as const }],
    ]);
    const out = makeSignalScoreCalc({ recorded, provisional: null, state: null, rescored })(klines) as Array<
      Record<string, unknown>
    >;
    expect(out.map((d) => d.rescored)).toEqual([undefined, undefined, -31]);
    expect(out[0].recorded).toBe(30);
    expect(out[2].tip).toBe('Re-scored -31.0 · Short score · computed after the fact, not the live record');
  });

  it('omits data coverage for a recorded bar that does not carry it', async () => {
    const { makeSignalScoreCalc } = await load();
    const live = new Map([[T0, { score: 31, tier: 'buy' as const, configVersion: 8 }]]);
    const out = makeSignalScoreCalc({ recorded: live, provisional: null, state: null })(klines) as Array<
      Record<string, unknown>
    >;
    expect(out[2].tip).toBe('Recorded 31.0 · Long score · configVersion 8');
  });

  it('returns a new function on every call', async () => {
    const { makeSignalScoreCalc } = await load();
    const snap = { recorded, provisional: null, state: null } as const;
    expect(makeSignalScoreCalc(snap)).not.toBe(makeSignalScoreCalc(snap));
  });

  it('writes the tooltip text for recorded, provisional and awaiting bars', async () => {
    const { makeSignalScoreCalc } = await load();
    const rec = makeSignalScoreCalc({ recorded, provisional, state: 'provisional' })(klines) as Array<Record<string, unknown>>;
    expect(rec[0].tip).toBe('Recorded 30.0 · Long score · 80% data coverage · configVersion 8');
    expect(rec[1].tip).toBe('Recorded -40.0 · Short score · 71% data coverage · configVersion 8');
    expect(rec[2].tip).toBe('Provisional -12.5 · Neutral · repaints until the bar closes, never recorded');
    const aw = makeSignalScoreCalc({ recorded, provisional, state: 'awaiting-record' })(klines) as Array<Record<string, unknown>>;
    expect(aw[2].tip).toBe('Closed · awaiting the recorded score');
  });
});

describe('ensureSignalScoreIndicatorRegistered', () => {
  it('registers once however often it is called', async () => {
    const mod = await load();
    mod.ensureSignalScoreIndicatorRegistered();
    mod.ensureSignalScoreIndicatorRegistered();
    expect(registerIndicator).toHaveBeenCalledTimes(1);
    const template = registerIndicator.mock.calls[0][0];
    expect(template.name).toBe(mod.SIGNAL_SCORE_INDICATOR);
    expect(template.series).toBe('normal');
    expect(template.minValue).toBe(-50);
    expect(template.maxValue).toBe(50);
    expect(template.figures.map((f: { key: string }) => f.key)).toEqual(['recorded', 'rescored', 'provisional']);
  });

  it('retries after a registration that threw', async () => {
    const mod = await load();
    registerIndicator.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => mod.ensureSignalScoreIndicatorRegistered()).toThrow('boom');
    mod.ensureSignalScoreIndicatorRegistered();
    expect(registerIndicator).toHaveBeenCalledTimes(2);
    mod.ensureSignalScoreIndicatorRegistered();
    expect(registerIndicator).toHaveBeenCalledTimes(2);
  });

  it('colours recorded bars by cutoff and draws provisional as a dashed amber outline', async () => {
    const mod = await load();
    mod.ensureSignalScoreIndicatorRegistered();
    const [recordedFig, rescoredFig, provFig] = registerIndicator.mock.calls[0][0].figures;
    const style = (fig: { styles: (p: unknown) => Record<string, unknown> }, v: Record<string, number>) =>
      fig.styles({ data: { current: v } });
    expect(style(recordedFig, { recorded: 28 }).color).toBe('#0ecb81');
    expect(style(recordedFig, { recorded: -28 }).color).toBe('#f6465d');
    expect(style(recordedFig, { recorded: 27.9 }).color).not.toBe('#0ecb81');
    expect(style(recordedFig, { recorded: -3 }).color).not.toBe('#f6465d');
    expect(style(rescoredFig, { rescored: 30 }).color).toBe('#0b8a5a');
    expect(style(rescoredFig, { rescored: -30 }).color).toBe('#b03547');
    expect(style(rescoredFig, { rescored: 3 }).color).toBe('#61656d');
    expect(style(provFig, { provisional: 5 })).toMatchObject({
      style: 'stroke', borderColor: '#f0b90b', borderStyle: 'dashed',
    });
  });

  it('draws four dashed guides and lets the default figures draw', async () => {
    const mod = await load();
    mod.ensureSignalScoreIndicatorRegistered();
    const { draw } = registerIndicator.mock.calls[0][0];
    const ctx = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
      stroke: vi.fn(), setLineDash: vi.fn(),
    };
    const convertToPixel = vi.fn((v: number) => 100 - v);
    const covered = draw({ ctx, bounding: { width: 400 }, yAxis: { convertToPixel } });
    expect(covered).toBe(false);
    expect(convertToPixel.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([-36, -28, 28, 36]);
    expect(ctx.stroke).toHaveBeenCalledTimes(4);
    expect(ctx.setLineDash).toHaveBeenCalledWith([4, 4]);
  });
});
