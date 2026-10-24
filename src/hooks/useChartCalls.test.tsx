import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChartCalls } from './useChartCalls';
import type { CallMark } from '@/lib/signals/track-record/chart-data';

const mockUseTrackRecordBars = vi.fn();

vi.mock('@/hooks/useTrackRecord', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useTrackRecord')>(
    '@/hooks/useTrackRecord'
  );
  return {
    ...actual,
    useTrackRecordBars: (...args: unknown[]) => mockUseTrackRecordBars(...args),
  };
});

describe('useChartCalls', () => {
  const defaultTrack = {
    bars: new Map(),
    calls: new Map<number, CallMark>(),
    boundary: null,
    configVersion: 8,
    horizonBars: 24,
    costPercent: 0.16,
    loading: false,
    error: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTrackRecordBars.mockReturnValue(defaultTrack);
  });

  it('is eligible at BTCUSDT 1h with visible: true in callsOverlay', () => {
    const { result } = renderHook(() => useChartCalls('BTCUSDT', '1h'));

    expect(result.current.eligible).toBe(true);
    expect(result.current.ineligibleReason).toBeNull();
    expect(result.current.show).toBe(true);
    expect(result.current.callsOverlay.visible).toBe(true);
  });

  it('sets ineligibleReason to "interval" at 1w and "symbol" for an outside coin', () => {
    const { result: intervalRes } = renderHook(() => useChartCalls('BTCUSDT', '1w'));
    expect(intervalRes.current.eligible).toBe(false);
    expect(intervalRes.current.ineligibleReason).toBe('interval');
    expect(intervalRes.current.callsOverlay.visible).toBe(false);

    const { result: symbolRes } = renderHook(() => useChartCalls('PEPEUSDT', '1h'));
    expect(symbolRes.current.eligible).toBe(false);
    expect(symbolRes.current.ineligibleReason).toBe('symbol');
    expect(symbolRes.current.callsOverlay.visible).toBe(false);
  });

  it('setShow(false) makes callsOverlay.visible false', () => {
    const { result } = renderHook(() => useChartCalls('BTCUSDT', '1h'));
    expect(result.current.callsOverlay.visible).toBe(true);

    act(() => {
      result.current.setShow(false);
    });

    expect(result.current.show).toBe(false);
    expect(result.current.callsOverlay.visible).toBe(false);
  });

  it('a range reported for BTCUSDT|1h is not passed to useTrackRecordBars after switching to ETHUSDT (it receives null)', () => {
    const { result, rerender } = renderHook(
      ({ symbol, interval }) => useChartCalls(symbol, interval),
      { initialProps: { symbol: 'BTCUSDT', interval: '1h' } }
    );

    act(() => {
      result.current.onLoadedRangeChange({ from: 1_000_000, to: 2_000_000 });
    });

    expect(mockUseTrackRecordBars).toHaveBeenLastCalledWith(
      'BTCUSDT',
      '1h',
      'day_trading',
      { from: 1_000_000, to: 2_000_000 }
    );

    rerender({ symbol: 'ETHUSDT', interval: '1h' });

    expect(mockUseTrackRecordBars).toHaveBeenLastCalledWith(
      'ETHUSDT',
      '1h',
      'day_trading',
      null
    );
  });

  it('the tally counts only calls inside the visible range', () => {
    const calls = new Map<number, CallMark>([
      [1000, { t: 1000, dir: 1, outcome: 'won', source: 'live', score: 30, tier: 'buy', fwd: 1.0 }],
      [2000, { t: 2000, dir: 1, outcome: 'cost', source: 'live', score: 25, tier: 'buy', fwd: 0.1 }],
      [3000, { t: 3000, dir: -1, outcome: 'wrong', source: 'live', score: -25, tier: 'sell', fwd: 0.5 }],
      [4000, { t: 4000, dir: 1, outcome: 'pending', source: 'live', score: 20, tier: 'buy', fwd: null }],
      [5000, { t: 5000, dir: 1, outcome: 'won', source: 'live', score: 35, tier: 'buy', fwd: 1.5 }],
    ]);

    mockUseTrackRecordBars.mockReturnValue({
      ...defaultTrack,
      calls,
    });

    const { result } = renderHook(() => useChartCalls('BTCUSDT', '1h'));

    expect(result.current.tally).toBeNull();

    act(() => {
      result.current.onVisibleRangeChange({ from: 1500, to: 4500 });
    });

    expect(result.current.tally).toEqual({
      calls: 3,
      right: 1,
      won: 0,
      cost: 1,
      wrong: 1,
      pending: 1,
    });
  });
});
