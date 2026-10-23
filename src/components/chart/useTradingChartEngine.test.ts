import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useTradingChartEngine,
  periodToInterval,
  type SignalOverlay,
  type CallsOverlay,
} from './useTradingChartEngine';
import type { CallMark } from '@/lib/signals/track-record/chart-data';
import { loadOverlays, saveOverlays, clearOverlays } from '@/lib/chart-storage';

const mockCreateIndicator = vi.fn().mockReturnValue('pane_1');
const mockRemoveIndicator = vi.fn().mockReturnValue(true);
const mockCreateOverlay = vi.fn().mockReturnValue('overlay_1');
const mockRemoveOverlay = vi.fn().mockReturnValue(true);
const mockSetDataLoader = vi.fn();
const mockSetSymbol = vi.fn();
const mockSetPeriod = vi.fn();
const mockResetData = vi.fn();
const mockSetStyles = vi.fn();
const mockSubscribeAction = vi.fn();
const mockUnsubscribeAction = vi.fn();
const mockOverrideIndicator = vi.fn();
const mockGetOverlays = vi.fn().mockReturnValue([]);
const mockOverrideOverlay = vi.fn();
const mockResize = vi.fn();
const mockDispose = vi.fn();
const mockGetDataList = vi.fn().mockReturnValue([]);
const mockGetVisibleRange = vi.fn().mockReturnValue({ from: 0, to: 0, realFrom: 0, realTo: 0 });
const mockConvertFromPixel = vi.fn().mockReturnValue([{}]);
const mockGetSymbol = vi.fn().mockReturnValue({ ticker: 'BTCUSDT' });
const mockGetPeriod = vi.fn().mockReturnValue({ type: 'hour', span: 1 });

const mockChart = {
  id: 'test-chart',
  createIndicator: mockCreateIndicator,
  removeIndicator: mockRemoveIndicator,
  createOverlay: mockCreateOverlay,
  removeOverlay: mockRemoveOverlay,
  setDataLoader: mockSetDataLoader,
  setSymbol: mockSetSymbol,
  setPeriod: mockSetPeriod,
  setStyles: mockSetStyles,
  overrideIndicator: mockOverrideIndicator,
  getOverlays: mockGetOverlays,
  overrideOverlay: mockOverrideOverlay,
  subscribeAction: mockSubscribeAction,
  unsubscribeAction: mockUnsubscribeAction,
  resetData: mockResetData,
  resize: mockResize,
  getDataList: mockGetDataList,
  getVisibleRange: mockGetVisibleRange,
  convertFromPixel: mockConvertFromPixel,
  getSymbol: mockGetSymbol,
  getPeriod: mockGetPeriod,
};

const mockRegisterIndicator = vi.fn();
const mockInit = vi.fn().mockReturnValue(mockChart);

vi.mock('klinecharts', () => ({
  init: (...args: unknown[]) => mockInit(...args),
  dispose: (...args: unknown[]) => mockDispose(...args),
  registerIndicator: (...args: unknown[]) => mockRegisterIndicator(...args),
}));

vi.mock('@/lib/chart-storage', () => ({
  saveOverlays: vi.fn(),
  loadOverlays: vi.fn().mockReturnValue([]),
  clearOverlays: vi.fn(),
}));

vi.mock('@/hooks/useChartResize', async () => {
  const { useRef } = await import('react');
  return {
    useChartResize: () => {
      const containerRef = useRef<HTMLDivElement>(null);
      if (!containerRef.current && typeof document !== 'undefined') {
        const el = document.createElement('div');
        el.getBoundingClientRect = () => ({
          width: 800,
          height: 600,
          top: 0,
          left: 0,
          right: 800,
          bottom: 600,
          x: 0,
          y: 0,
          toJSON: () => {},
        });
        containerRef.current = el;
      }
      return { containerRef, width: 800, height: 600 };
    },
  };
});

vi.mock('@/hooks/useMarketStream', () => ({
  useMarketStreamStatus: () => ({
    status: 'connected',
    lastMessageAt: Date.now(),
    retry: vi.fn(),
  }),
}));

vi.mock('@/lib/market-stream/client', () => ({
  getStreamClient: () => ({
    subscribe: vi.fn().mockReturnValue(vi.fn()),
  }),
}));

describe('periodToInterval', () => {
  it('converts minute period to interval string', () => {
    expect(periodToInterval({ type: 'minute', span: 5 })).toBe('5m');
    expect(periodToInterval({ type: 'minute', span: 1 })).toBe('1m');
    expect(periodToInterval({ type: 'minute', span: 15 })).toBe('15m');
  });

  it('converts hour period to interval string', () => {
    expect(periodToInterval({ type: 'hour', span: 1 })).toBe('1h');
    expect(periodToInterval({ type: 'hour', span: 4 })).toBe('4h');
  });

  it('converts day period to interval string', () => {
    expect(periodToInterval({ type: 'day', span: 1 })).toBe('1d');
  });

  it('converts week period to interval string', () => {
    expect(periodToInterval({ type: 'week', span: 1 })).toBe('1w');
  });

  it('converts month period to interval string', () => {
    expect(periodToInterval({ type: 'month', span: 1 })).toBe('1M');
  });

  it('returns 1h for unknown period type', () => {
    expect(periodToInterval({ type: 'year' as never, span: 1 })).toBe('1h');
  });
});

describe('useTradingChartEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInit.mockReturnValue(mockChart);
    mockGetDataList.mockReturnValue([]);
    mockGetPeriod.mockReturnValue({ type: 'hour', span: 1 });
    mockGetSymbol.mockReturnValue({ ticker: 'BTCUSDT' });
    mockGetVisibleRange.mockReturnValue({ from: 0, to: 0, realFrom: 0, realTo: 0 });
    mockConvertFromPixel.mockReturnValue([{}]);
    mockGetOverlays.mockReturnValue([]);
    vi.mocked(loadOverlays).mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('inits chart, sets data loader, and disposes on unmount', () => {
    const { unmount } = renderHook(() =>
      useTradingChartEngine({
        symbol: 'BTCUSDT',
        interval: '1h',
      })
    );

    expect(mockInit).toHaveBeenCalled();
    const initArgs = mockInit.mock.calls[0];
    expect(initArgs[1]).toMatchObject({
      locale: 'en-US',
      timezone: 'Etc/UTC',
    });
    expect(initArgs[1].styles).toBeDefined();

    expect(mockSetDataLoader).toHaveBeenCalledWith(
      expect.objectContaining({
        getBars: expect.any(Function),
        subscribeBar: expect.any(Function),
        unsubscribeBar: expect.any(Function),
      })
    );

    unmount();
    expect(mockDispose).toHaveBeenCalled();
  });

  it('toggleIndicator creates and removes an indicator', () => {
    const { result } = renderHook(() =>
      useTradingChartEngine({
        symbol: 'BTCUSDT',
        interval: '1h',
      })
    );

    // EMA is initially disabled in DEFAULT_INDICATORS
    const emaBefore = result.current.indicators.find((ind) => ind.id === 'EMA');
    expect(emaBefore?.enabled).toBe(false);

    // Enabling EMA should call createIndicator
    act(() => {
      result.current.toggleIndicator('EMA');
    });

    expect(mockCreateIndicator).toHaveBeenCalledWith('EMA', true, { id: 'candle_pane' });
    const emaAfterEnable = result.current.indicators.find((ind) => ind.id === 'EMA');
    expect(emaAfterEnable?.enabled).toBe(true);

    // Disabling EMA should call removeIndicator
    act(() => {
      result.current.toggleIndicator('EMA');
    });

    expect(mockRemoveIndicator).toHaveBeenCalledWith({ paneId: 'candle_pane', name: 'EMA' });
    const emaAfterDisable = result.current.indicators.find((ind) => ind.id === 'EMA');
    expect(emaAfterDisable?.enabled).toBe(false);
  });

  it('groups indicators into overlays, oscillators, and volume', () => {
    const { result } = renderHook(() =>
      useTradingChartEngine({
        symbol: 'BTCUSDT',
        interval: '1h',
      })
    );

    expect(result.current.overlayIndicators.every((i) => i.category === 'overlay')).toBe(true);
    expect(result.current.oscillatorIndicators.every((i) => i.category === 'oscillator')).toBe(true);
    expect(result.current.volumeIndicators.every((i) => i.category === 'volume')).toBe(true);
  });

  it('creates default indicators at init when initialIndicators is omitted', () => {
    renderHook(() =>
      useTradingChartEngine({
        symbol: 'BTCUSDT',
        interval: '1h',
      })
    );

    expect(mockCreateIndicator).toHaveBeenCalledWith('MA', true, { id: 'candle_pane' });
    expect(mockCreateIndicator).toHaveBeenCalledWith('VOL', false);
  });

  it('creates no indicators at init when initialIndicators is empty', () => {
    const { result } = renderHook(() =>
      useTradingChartEngine({
        symbol: 'BTCUSDT',
        interval: '1h',
        initialIndicators: [],
      })
    );

    expect(mockCreateIndicator).not.toHaveBeenCalled();
    expect(result.current.indicators).toEqual([]);
  });

  it('applies showCandleTooltip false to init styles and subsequent setStyles', () => {
    renderHook(() =>
      useTradingChartEngine({
        symbol: 'BTCUSDT',
        interval: '1h',
        showCandleTooltip: false,
      })
    );

    const initArgs = mockInit.mock.calls[0];
    expect(initArgs[1].styles?.candle?.tooltip?.showRule).toBe('none');
    expect(mockSetStyles).toHaveBeenCalledWith(
      expect.objectContaining({
        candle: expect.objectContaining({
          tooltip: { showRule: 'none' },
        }),
      })
    );
  });

  it('restores overlays by default (restoreOverlays: true) and saves drawings', () => {
    vi.mocked(loadOverlays).mockReturnValue([
      { name: 'segment', points: [{ timestamp: 1000, value: 50000 }] },
    ]);
    mockGetOverlays.mockReturnValue([
      { name: 'segment', points: [{ timestamp: 1000, value: 50000 }] },
    ]);

    const { result } = renderHook(() =>
      useTradingChartEngine({
        symbol: 'BTCUSDT',
        interval: '1h',
      })
    );

    expect(loadOverlays).toHaveBeenCalledWith('BTCUSDT');
    expect(mockCreateOverlay).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'segment',
        points: [{ timestamp: 1000, value: 50000 }],
      })
    );

    act(() => {
      result.current.activateDrawingTool('horizontalStraightLine');
    });

    const createCall = mockCreateOverlay.mock.calls.find(
      (call) => call[0]?.name === 'horizontalStraightLine'
    );
    expect(createCall).toBeDefined();

    act(() => {
      createCall![0].onDrawEnd();
    });
    expect(saveOverlays).toHaveBeenCalledWith('BTCUSDT', expect.any(Array));

    act(() => {
      result.current.clearDrawings();
    });
    expect(clearOverlays).toHaveBeenCalledWith('BTCUSDT');
  });

  it('does not load or save overlays when restoreOverlays is false', () => {
    vi.mocked(loadOverlays).mockReturnValue([
      { name: 'segment', points: [{ timestamp: 1000, value: 50000 }] },
    ]);
    mockGetOverlays.mockReturnValue([
      { name: 'segment', points: [{ timestamp: 1000, value: 50000 }] },
    ]);

    const { result } = renderHook(() =>
      useTradingChartEngine({
        symbol: 'BTCUSDT',
        interval: '1h',
        restoreOverlays: false,
      })
    );

    expect(loadOverlays).not.toHaveBeenCalled();

    act(() => {
      result.current.activateDrawingTool('horizontalStraightLine');
    });

    const createCall = mockCreateOverlay.mock.calls.find(
      (call) => call[0]?.name === 'horizontalStraightLine'
    );
    expect(createCall).toBeDefined();

    act(() => {
      createCall![0].onDrawEnd();
    });
    expect(saveOverlays).not.toHaveBeenCalled();

    act(() => {
      result.current.clearDrawings();
    });
    expect(clearOverlays).not.toHaveBeenCalled();
  });

  describe('history paging', () => {
    const HOUR = 3_600_000;
    const T = Date.UTC(2026, 9, 1);
    const loader = () => mockSetDataLoader.mock.calls[mockSetDataLoader.mock.calls.length - 1][0];
    const apiBars = (n: number, last: number) =>
      Array.from({ length: n }, (_, i) => ({
        timestamp: last - (n - 1 - i) * HOUR,
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 3,
      }));
    const params = (type: string, timestamp: number | null) => ({
      type,
      timestamp,
      symbol: { ticker: 'BTCUSDT' },
      period: { type: 'hour' as const, span: 1 },
      callback: vi.fn(),
    });

    it('lets older pages load after the first page and reports the loaded range', async () => {
      const onLoaded = vi.fn();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(apiBars(500, T))));
      mockGetDataList.mockReturnValue(apiBars(500, T));
      renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
          onLoadedRangeChange: onLoaded,
        })
      );
      const p = params('init', null);
      await act(async () => {
        await loader().getBars(p);
      });
      expect(p.callback).toHaveBeenCalledWith(expect.any(Array), { forward: true, backward: false });
      expect(onLoaded).toHaveBeenCalledWith({ from: T - 499 * HOUR, to: T });
    });

    it("asks for the page before the first bar on a 'forward' load (KlineCharts older direction)", async () => {
      const onLoaded = vi.fn();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify(apiBars(1000, T - 500 * HOUR))));
      mockGetDataList.mockReturnValue(apiBars(1500, T));
      renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
          onLoadedRangeChange: onLoaded,
        })
      );
      const p = params('forward', T - 499 * HOUR);
      await loader().getBars(p);
      const url = String(fetchSpy.mock.calls[0][0]);
      expect(url).toContain('/api/prices/history?');
      expect(url).toContain('limit=1000');
      expect(url).toContain(`endTime=${T - 499 * HOUR - 1}`);
      expect(p.callback).toHaveBeenCalledWith(expect.any(Array), { forward: true });
      expect(p.callback.mock.calls[0][0]).toHaveLength(1000);
      expect(onLoaded).toHaveBeenLastCalledWith({ from: T - 1499 * HOUR, to: T });
    });

    it('stops paging when a short page reaches the start of the history', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(apiBars(10, T - 500 * HOUR))));
      renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
        })
      );
      const p = params('forward', T - 499 * HOUR);
      await loader().getBars(p);
      expect(p.callback).toHaveBeenCalledWith(expect.any(Array), { forward: false });
    });

    it('drops an older page that arrives after an interval change', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(apiBars(1000, T - 500 * HOUR))));
      renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
        })
      );
      const p = params('forward', T - 499 * HOUR);
      mockGetPeriod.mockReturnValueOnce({ type: 'minute', span: 5 });
      await loader().getBars(p);
      expect(p.callback).not.toHaveBeenCalled();
    });

    it('keeps paging on after a failed page, and never loads newer than the live bar', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 429 }));
      renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
        })
      );
      const older = params('forward', T);
      await loader().getBars(older);
      expect(older.callback).toHaveBeenCalledWith([], { forward: true });
      const newer = params('backward', T);
      await loader().getBars(newer);
      expect(newer.callback).toHaveBeenCalledWith([], false);
    });
  });

  describe('history error', () => {
    const HOUR = 3_600_000;
    const T = Date.UTC(2026, 9, 1);
    const loader = () => mockSetDataLoader.mock.calls[mockSetDataLoader.mock.calls.length - 1][0];
    const apiBars = (n: number, last: number) =>
      Array.from({ length: n }, (_, i) => ({
        timestamp: last - (n - 1 - i) * HOUR,
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 3,
      }));
    const params = (type: string, timestamp: number | null) => ({
      type,
      timestamp,
      symbol: { ticker: 'BTCUSDT' },
      period: { type: 'hour' as const, span: 1 },
      callback: vi.fn(),
    });

    it('sets historyError when init load fails, and handleRefresh resets data and clears it', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));
      const { result } = renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
        })
      );
      const p = params('init', null);
      await act(async () => {
        await loader().getBars(p);
      });
      expect(p.callback).toHaveBeenCalledWith([], false);
      expect(result.current.historyError).toBe(true);
      expect(result.current.isLoading).toBe(false);

      act(() => {
        result.current.handleRefresh();
      });
      expect(mockResetData).toHaveBeenCalledTimes(1);
      expect(result.current.historyError).toBe(false);
      expect(result.current.isLoading).toBe(true);
    });

    it('leaves no error on a successful init load', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(apiBars(500, T))));
      const { result } = renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
        })
      );
      const p = params('init', null);
      await act(async () => {
        await loader().getBars(p);
      });
      expect(p.callback).toHaveBeenCalledWith(expect.any(Array), { forward: true, backward: false });
      expect(result.current.historyError).toBe(false);
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('signal score overlay', () => {
    const overlay = (over: Partial<SignalOverlay> = {}): SignalOverlay => ({
      visible: true,
      recorded: new Map(),
      provisional: null,
      state: null,
      ...over,
    });
    const pane = { paneId: 'signal_score_pane', name: 'SIGNAL_SCORE' };

    it('creates no pane without the option or when not visible', () => {
      const { rerender } = renderHook(
        (props: { overlay?: SignalOverlay }) =>
          useTradingChartEngine({
            symbol: 'BTCUSDT',
            interval: '1h',
            signalOverlay: props.overlay,
          }),
        { initialProps: {} }
      );
      rerender({ overlay: overlay({ visible: false }) });
      expect(mockCreateIndicator).not.toHaveBeenCalledWith('SIGNAL_SCORE', expect.anything(), expect.anything());
      expect(mockOverrideIndicator).not.toHaveBeenCalled();
      expect(mockRemoveIndicator).not.toHaveBeenCalledWith(pane);
    });

    it('creates the pane when visible and keeps the default indicators', () => {
      renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
          signalOverlay: overlay(),
        })
      );
      expect(mockRegisterIndicator).toHaveBeenCalled();
      expect(mockCreateIndicator).toHaveBeenCalledWith('SIGNAL_SCORE', false, { id: 'signal_score_pane', height: 140 });
      expect(mockCreateIndicator).toHaveBeenCalledWith('MA', true, { id: 'candle_pane' });
      expect(mockCreateIndicator).toHaveBeenCalledWith('VOL', false);
    });

    it('removes the pane when it stops being visible', () => {
      const { rerender } = renderHook(
        (props: { overlay: SignalOverlay }) =>
          useTradingChartEngine({
            symbol: 'BTCUSDT',
            interval: '1h',
            signalOverlay: props.overlay,
          }),
        { initialProps: { overlay: overlay() } }
      );
      rerender({ overlay: overlay({ visible: false }) });
      expect(mockRemoveIndicator).toHaveBeenCalledWith(pane);
    });

    it('passes a new calc to overrideIndicator on every overlay change', () => {
      const recorded = new Map();
      const { rerender } = renderHook(
        (props: { overlay: SignalOverlay }) =>
          useTradingChartEngine({
            symbol: 'BTCUSDT',
            interval: '1h',
            signalOverlay: props.overlay,
          }),
        { initialProps: { overlay: overlay({ recorded }) } }
      );
      const calls = () => mockOverrideIndicator.mock.calls.map((c) => c[0]);
      expect(calls().at(-1)).toMatchObject({ name: 'SIGNAL_SCORE', calc: expect.any(Function) });
      const first = calls().at(-1).calc;

      rerender({ overlay: overlay({ recorded, state: 'provisional' }) });
      const second = calls().at(-1).calc;
      expect(second).not.toBe(first);

      rerender({ overlay: overlay({ recorded: new Map(), state: 'provisional' }) });
      expect(calls().at(-1).calc).not.toBe(second);
    });

    it('does not override again when nothing changed', () => {
      const recorded = new Map();
      const { rerender } = renderHook(
        (props: { overlay: SignalOverlay }) =>
          useTradingChartEngine({
            symbol: 'BTCUSDT',
            interval: '1h',
            signalOverlay: props.overlay,
          }),
        { initialProps: { overlay: overlay({ recorded }) } }
      );
      const count = mockOverrideIndicator.mock.calls.length;
      rerender({ overlay: overlay({ recorded }) });
      expect(mockOverrideIndicator.mock.calls.length).toBe(count);
    });
  });

  describe('past calls overlay', () => {
    const T = Date.UTC(2026, 9, 1);
    const call: CallMark = {
      t: T,
      dir: 1,
      outcome: 'won',
      source: 'rescore',
      score: 31,
      tier: 'buy',
      fwd: 0.5,
    };
    const calls = new Map([[T, call]]);
    const overlay = (over: Partial<CallsOverlay> = {}): CallsOverlay => ({
      visible: true,
      calls,
      boundary: T + 3_600_000,
      horizonBars: 24,
      costPercent: 0.16,
      ...over,
    });

    it('stacks the calls on the price pane and removes them when hidden', () => {
      const { rerender } = renderHook(
        (props: { overlay: CallsOverlay }) =>
          useTradingChartEngine({
            symbol: 'BTCUSDT',
            interval: '1h',
            callsOverlay: props.overlay,
          }),
        { initialProps: { overlay: overlay() } }
      );
      expect(mockCreateIndicator).toHaveBeenCalledWith('SIGNAL_CALLS', true, { id: 'candle_pane' });
      rerender({ overlay: overlay({ visible: false }) });
      expect(mockRemoveIndicator).toHaveBeenCalledWith({ paneId: 'candle_pane', name: 'SIGNAL_CALLS' });
    });

    it('passes the calls as a new calc and the boundary and horizon as redraw data', () => {
      renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
          callsOverlay: overlay(),
        })
      );
      const last = mockOverrideIndicator.mock.calls
        .map((c) => c[0])
        .filter((o) => o.name === 'SIGNAL_CALLS')
        .at(-1);
      expect(last).toMatchObject({
        calc: expect.any(Function),
        extendData: { boundary: T + 3_600_000, hover: null, horizonBars: 24 },
      });
    });

    it('creates nothing without the option', () => {
      renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
        })
      );
      expect(mockCreateIndicator).not.toHaveBeenCalledWith('SIGNAL_CALLS', expect.anything(), expect.anything());
    });

    it('marks the call under the crosshair for its span, updates hoverCall, and clears on leaving', () => {
      const { result } = renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
          callsOverlay: overlay(),
        })
      );
      const handler = mockSubscribeAction.mock.calls.find((c) => c[0] === 'onCrosshairChange')?.[1];
      const callsOverrides = () =>
        mockOverrideIndicator.mock.calls.map((c) => c[0]).filter((o) => o.name === 'SIGNAL_CALLS');

      act(() => {
        handler({ kLineData: { timestamp: T, open: 1, high: 1, low: 1, close: 1 } });
      });
      expect(result.current.hoverCall).toEqual(call);
      expect(callsOverrides().at(-1)).toEqual({
        name: 'SIGNAL_CALLS',
        extendData: { boundary: T + 3_600_000, horizonBars: 24, hover: T },
      });

      const count = callsOverrides().length;
      act(() => {
        handler({ kLineData: { timestamp: T, open: 1, high: 1, low: 1, close: 1 } });
      });
      expect(callsOverrides()).toHaveLength(count);

      act(() => {
        handler({ kLineData: { timestamp: T + 7_200_000, open: 1, high: 1, low: 1, close: 1 } });
      });
      expect(result.current.hoverCall).toBeNull();
      expect(callsOverrides().at(-1)?.extendData.hover).toBeNull();
    });

    it('resolves the hovered bar from the pointer x when action carries no kLineData', () => {
      const list = [0, 1, 2].map((i) => ({
        timestamp: T + (i - 1) * 3_600_000,
        open: 1,
        high: 1,
        low: 1,
        close: 1,
      }));
      mockGetDataList.mockReturnValue(list);
      mockConvertFromPixel.mockReturnValue([{ dataIndex: 1, timestamp: T }]);

      const { result } = renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
          callsOverlay: overlay(),
        })
      );
      const handler = mockSubscribeAction.mock.calls.find((c) => c[0] === 'onCrosshairChange')?.[1];
      act(() => {
        handler({ x: 420, y: 80, paneId: 'candle_pane' });
      });

      expect(mockConvertFromPixel).toHaveBeenCalledWith([{ x: 420 }], { paneId: 'candle_pane' });
      expect(result.current.hoverCall).toEqual(call);
    });

    it('reports the visible window by open time after scrolling settles', () => {
      vi.useFakeTimers();
      try {
        const onVisible = vi.fn();
        const list = [0, 1, 2, 3, 4].map((i) => ({
          timestamp: T + i * 3_600_000,
          open: 1,
          high: 1,
          low: 1,
          close: 1,
        }));
        mockGetDataList.mockReturnValue(list);
        mockGetVisibleRange.mockReturnValue({ from: 1, to: 4, realFrom: 1.4, realTo: 3.6 });
        renderHook(() =>
          useTradingChartEngine({
            symbol: 'BTCUSDT',
            interval: '1h',
            onVisibleRangeChange: onVisible,
          })
        );
        const handler = mockSubscribeAction.mock.calls.find((c) => c[0] === 'onVisibleRangeChange')?.[1];
        act(() => {
          handler();
          handler();
        });
        expect(onVisible).not.toHaveBeenCalled();
        act(() => {
          vi.advanceTimersByTime(250);
        });
        expect(onVisible).toHaveBeenCalledTimes(1);
        expect(onVisible).toHaveBeenCalledWith({ from: T + 3_600_000, to: T + 3 * 3_600_000 });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('indicator toggling', () => {
    it('calls createIndicator when enabling an oscillator indicator', () => {
      const { result } = renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
        })
      );

      act(() => {
        result.current.toggleIndicator('RSI');
      });

      expect(mockCreateIndicator).toHaveBeenCalledWith('RSI', false);
    });

    it('enabling RSI, then disabling it, calls removeIndicator({ name: "RSI" })', () => {
      const { result } = renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
        })
      );

      act(() => {
        result.current.toggleIndicator('RSI');
      });
      expect(mockCreateIndicator).toHaveBeenCalledWith('RSI', false);

      act(() => {
        result.current.toggleIndicator('RSI');
      });
      expect(mockRemoveIndicator).toHaveBeenCalledWith({ name: 'RSI' });
    });

    it('calls removeIndicator when disabling the default Moving Average indicator', () => {
      const { result } = renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
        })
      );

      act(() => {
        result.current.toggleIndicator('MA');
      });

      expect(mockRemoveIndicator).toHaveBeenCalledWith({ paneId: 'candle_pane', name: 'MA' });
    });

    it('calls removeIndicator when disabling the default Volume indicator', () => {
      const { result } = renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
        })
      );

      act(() => {
        result.current.toggleIndicator('VOL');
      });

      expect(mockRemoveIndicator).toHaveBeenCalledWith({ name: 'VOL' });
    });
  });

  describe('drawing tools', () => {
    it('activateDrawingTool creates the overlay with its name and mode', () => {
      const { result } = renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
        })
      );

      act(() => {
        result.current.activateDrawingTool('segment');
      });

      expect(mockCreateOverlay).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'segment',
          mode: 'normal',
        })
      );
    });

    it('clearDrawings removes the overlays and clears storage', () => {
      const { result } = renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
        })
      );

      act(() => {
        result.current.clearDrawings();
      });

      expect(mockRemoveOverlay).toHaveBeenCalled();
      expect(clearOverlays).toHaveBeenCalledWith('BTCUSDT');
    });

    it('toggleMagnetMode toggles magnet mode and passes weak_magnet to createOverlay', () => {
      const { result } = renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
        })
      );

      expect(result.current.magnetMode).toBe('normal');

      act(() => {
        result.current.toggleMagnetMode();
      });
      expect(result.current.magnetMode).toBe('weak_magnet');

      act(() => {
        result.current.activateDrawingTool('rayLine');
      });

      expect(mockCreateOverlay).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'rayLine',
          mode: 'weak_magnet',
        })
      );
    });

    it('loads saved overlays on mount', () => {
      vi.mocked(loadOverlays).mockReturnValue([
        { name: 'segment', points: [{ timestamp: 1000, value: 50 }] },
      ]);

      renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
        })
      );

      expect(loadOverlays).toHaveBeenCalledWith('BTCUSDT');
      expect(mockCreateOverlay).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'segment',
          points: [{ timestamp: 1000, value: 50 }],
        })
      );
    });

    it('with restoreOverlays: false, saved overlays do not load and nothing is written', () => {
      vi.mocked(loadOverlays).mockReturnValue([
        { name: 'segment', points: [{ timestamp: 1000, value: 50 }] },
      ]);
      mockGetOverlays.mockReturnValue([
        { name: 'segment', points: [{ timestamp: 1000, value: 50 }] },
      ]);

      const { result } = renderHook(() =>
        useTradingChartEngine({
          symbol: 'BTCUSDT',
          interval: '1h',
          restoreOverlays: false,
        })
      );

      expect(loadOverlays).not.toHaveBeenCalled();

      act(() => {
        result.current.activateDrawingTool('horizontalStraightLine');
      });

      const createCall = mockCreateOverlay.mock.calls.find(
        (call) => call[0]?.name === 'horizontalStraightLine'
      );
      expect(createCall).toBeDefined();

      act(() => {
        createCall![0].onDrawEnd();
      });
      expect(saveOverlays).not.toHaveBeenCalled();

      act(() => {
        result.current.clearDrawings();
      });
      expect(clearOverlays).not.toHaveBeenCalled();
    });
  });
});
