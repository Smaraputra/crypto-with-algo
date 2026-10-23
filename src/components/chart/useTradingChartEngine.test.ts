import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTradingChartEngine } from './useTradingChartEngine';

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

describe('useTradingChartEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInit.mockReturnValue(mockChart);
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
});
