import type React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFormingBarStore } from '@/stores/formingBarStore';
import { periodToInterval, TradingChart, INTERVALS, PRIMARY_INTERVALS, MORE_INTERVALS, CHART_TYPES, DRAWING_TOOLS } from './TradingChart';

// Mock klinecharts module (canvas-based, won't work in jsdom)
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

const mockSaveOverlays = vi.fn();
const mockLoadOverlays = vi.fn().mockReturnValue([]);
const mockClearOverlays = vi.fn();

vi.mock('@/lib/chart-storage', () => ({
  saveOverlays: (...args: unknown[]) => mockSaveOverlays(...args),
  loadOverlays: (...args: unknown[]) => mockLoadOverlays(...args),
  clearOverlays: (...args: unknown[]) => mockClearOverlays(...args),
}));

// Mock useChartResize to provide valid dimensions
vi.mock('@/hooks/useChartResize', async () => {
  const { useRef } = await import('react');
  return {
    useChartResize: () => {
      const containerRef = useRef<HTMLDivElement>(null);
      return { containerRef, width: 800, height: 600 };
    },
  };
});

// Mock ResizeObserver
class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

const {
  mockUnsubSpot,
  mockUnsubPerp,
  capturedSpot,
  capturedPerp,
  mockSpotClient,
  mockPerpClient,
  mockStreamStatus,
  mockUseMarketStreamStatus,
} = vi.hoisted(() => {
  const unsubSpot = vi.fn();
  const unsubPerp = vi.fn();
  const capturedSpot: Array<{ streams: readonly string[]; onFrame: (frame: unknown) => void }> = [];
  const capturedPerp: Array<{ streams: readonly string[]; onFrame: (frame: unknown) => void }> = [];
  const mockSpotClient = {
    subscribe: vi.fn((streams: readonly string[], onFrame: (frame: unknown) => void) => {
      capturedSpot.push({ streams, onFrame });
      return unsubSpot;
    }),
  };
  const mockPerpClient = {
    subscribe: vi.fn((streams: readonly string[], onFrame: (frame: unknown) => void) => {
      capturedPerp.push({ streams, onFrame });
      return unsubPerp;
    }),
  };
  const mockStreamStatus = {
    status: 'connecting' as 'connecting' | 'live' | 'stale' | 'reconnecting' | 'offline',
    lastMessageAt: null as number | null,
    isConnected: false,
    retry: vi.fn(),
  };
  const mockUseMarketStreamStatus = vi.fn((_market?: string) => {
    void _market;
    return mockStreamStatus;
  });
  return {
    mockUnsubSpot: unsubSpot,
    mockUnsubPerp: unsubPerp,
    capturedSpot,
    capturedPerp,
    mockSpotClient,
    mockPerpClient,
    mockStreamStatus,
    mockUseMarketStreamStatus,
  };
});

const mockUnsub = mockUnsubSpot;
const captured = capturedSpot;

vi.mock('@/lib/market-stream/client', () => ({
  getMarketStreamClient: () => mockSpotClient,
  getPerpMarketStreamClient: () => mockPerpClient,
  getStreamClient: (market: 'spot' | 'perp' = 'spot') =>
    market === 'perp' ? mockPerpClient : mockSpotClient,
}));

vi.mock('@/hooks/useMarketStream', () => ({
  useMarketStreamStatus: (market?: string) => mockUseMarketStreamStatus(market),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockUnsubSpot.mockClear();
  mockUnsubPerp.mockClear();
  mockSpotClient.subscribe.mockClear();
  mockPerpClient.subscribe.mockClear();
  capturedSpot.length = 0;
  capturedPerp.length = 0;
  mockUseMarketStreamStatus.mockClear();
  mockStreamStatus.status = 'connecting';
  mockStreamStatus.lastMessageAt = null;
  mockStreamStatus.isConnected = false;
  mockStreamStatus.retry = vi.fn();
  // Mock getBoundingClientRect to return valid dimensions
  Element.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
    width: 800,
    height: 600,
    top: 0,
    left: 0,
    bottom: 600,
    right: 800,
    x: 0,
    y: 0,
    toJSON: vi.fn(),
  });
});

const origFullscreenEnabled = Object.getOwnPropertyDescriptor(document, 'fullscreenEnabled');
const origFullscreenElement = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
const origRequestFullscreen = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'requestFullscreen');
const origExitFullscreen = Object.getOwnPropertyDescriptor(document, 'exitFullscreen');

afterEach(() => {
  vi.restoreAllMocks();
  if (origFullscreenEnabled) {
    Object.defineProperty(document, 'fullscreenEnabled', origFullscreenEnabled);
  } else {
    delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
  }
  if (origFullscreenElement) {
    Object.defineProperty(document, 'fullscreenElement', origFullscreenElement);
  } else {
    delete (document as unknown as Record<string, unknown>).fullscreenElement;
  }
  if (origRequestFullscreen) {
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', origRequestFullscreen);
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen;
  }
  if (origExitFullscreen) {
    Object.defineProperty(document, 'exitFullscreen', origExitFullscreen);
  } else {
    delete (document as unknown as Record<string, unknown>).exitFullscreen;
  }
});

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

describe('interval constants', () => {
  it('INTERVALS has 13 entries', () => {
    expect(INTERVALS).toHaveLength(13);
  });

  it('PRIMARY_INTERVALS has 6 entries', () => {
    expect(PRIMARY_INTERVALS).toHaveLength(6);
    expect(PRIMARY_INTERVALS).toEqual(['1m', '5m', '15m', '1h', '4h', '1d']);
  });

  it('MORE_INTERVALS has 7 entries', () => {
    expect(MORE_INTERVALS).toHaveLength(7);
    expect(MORE_INTERVALS).toEqual(['3m', '30m', '2h', '6h', '12h', '1w', '1M']);
  });

  it('all INTERVALS have corresponding period mappings', () => {
    for (const interval of INTERVALS) {
      expect(periodToInterval(interval.period)).toBe(interval.value);
    }
  });
});

describe('TradingChart', () => {
  describe('toolbar rendering', () => {
    it('renders 6 primary interval tab triggers', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      expect(screen.getByRole('tab', { name: '1m' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '5m' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '15m' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '1H' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '4H' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '1D' })).toBeInTheDocument();
    });

    it('renders "More" dropdown for additional intervals', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      expect(screen.getByRole('button', { name: /more/i })).toBeInTheDocument();
    });

    it('shows selected interval label in "More" button when a secondary interval is active', () => {
      render(<TradingChart symbol="BTCUSDT" interval="2h" />);

      // When interval is 2h (a MORE_INTERVAL), the button should show "2H" instead of "More"
      expect(screen.getByRole('button', { name: /2H/i })).toBeInTheDocument();
    });

    it('renders more interval options in dropdown', async () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      const moreButton = screen.getByRole('button', { name: /more/i });
      fireEvent.pointerDown(moreButton, { button: 0, pointerType: 'mouse' });

      const item3m = await screen.findByRole('menuitem', { name: '3m' });
      expect(item3m).toBeInTheDocument();
      expect(await screen.findByRole('menuitem', { name: '30m' })).toBeInTheDocument();
      expect(await screen.findByRole('menuitem', { name: '2H' })).toBeInTheDocument();
      expect(await screen.findByRole('menuitem', { name: '6H' })).toBeInTheDocument();
      expect(await screen.findByRole('menuitem', { name: '12H' })).toBeInTheDocument();
      expect(await screen.findByRole('menuitem', { name: '1W' })).toBeInTheDocument();
      expect(await screen.findByRole('menuitem', { name: '1M' })).toBeInTheDocument();
    });

    it('restricts tabs and menu options when intervalOptions is provided', async () => {
      render(
        <TradingChart
          symbol="BTCUSDT"
          interval="1h"
          intervalOptions={['15m', '1h', '30m']}
        />
      );

      // Only the specified primary intervals should be in the tabs
      expect(screen.getByRole('tab', { name: '15m' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '1H' })).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: '1m' })).not.toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: '5m' })).not.toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: '4H' })).not.toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: '1D' })).not.toBeInTheDocument();

      // "More" button should be present since 30m is in moreList
      const moreButton = screen.getByRole('button', { name: /more/i });
      expect(moreButton).toBeInTheDocument();
      fireEvent.pointerDown(moreButton, { button: 0, pointerType: 'mouse' });

      expect(await screen.findByRole('menuitem', { name: '30m' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: '3m' })).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: '2H' })).not.toBeInTheDocument();
    });

    it('does not render "More" dropdown when intervalOptions contains no secondary intervals', () => {
      render(
        <TradingChart
          symbol="BTCUSDT"
          interval="1h"
          intervalOptions={['15m', '1h']}
        />
      );

      expect(screen.getByRole('tab', { name: '15m' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '1H' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /more/i })).not.toBeInTheDocument();
    });

    it('renders the indicators dropdown button', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      expect(screen.getByRole('button', { name: /indicators/i })).toBeInTheDocument();
    });

    it('renders all 8 drawing tool buttons, magnet toggle, and clear button', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      for (const tool of DRAWING_TOOLS) {
        expect(screen.getByLabelText(tool.label)).toBeInTheDocument();
      }
      expect(screen.getByLabelText('Enable magnet mode')).toBeInTheDocument();
      expect(screen.getByLabelText('Clear drawings')).toBeInTheDocument();
    });

    it('shows WS status as Connecting initially', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      expect(screen.getByText('Connecting')).toBeInTheDocument();
    });

    it('shows Stale and Retry live data button when status is stale, clicking calls retry', () => {
      mockStreamStatus.status = 'stale';
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      expect(screen.getByText('Stale')).toBeInTheDocument();
      const retryButton = screen.getByRole('button', { name: 'Retry live data' });
      expect(retryButton).toBeInTheDocument();
      fireEvent.click(retryButton);
      expect(mockStreamStatus.retry).toHaveBeenCalledTimes(1);
    });
  });

  describe('chart initialization', () => {
    it('calls init() with valid dimensions', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      expect(mockInit).toHaveBeenCalled();
      const initArgs = mockInit.mock.calls[0];
      // First arg is the container element, second is options
      expect(initArgs[1]).toMatchObject({
        locale: 'en-US',
        timezone: 'Etc/UTC',
      });
    });

    it('calls setDataLoader() with getBars and subscribeBar', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      expect(mockSetDataLoader).toHaveBeenCalledWith(
        expect.objectContaining({
          getBars: expect.any(Function),
          subscribeBar: expect.any(Function),
          unsubscribeBar: expect.any(Function),
        })
      );
    });

    it('creates default indicators (MA and VOL)', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      // MA is overlay -> stacked on the price pane, so other overlays can join it
      expect(mockCreateIndicator).toHaveBeenCalledWith('MA', true, { id: 'candle_pane' });
      // VOL is volume -> createIndicator('VOL', false)
      expect(mockCreateIndicator).toHaveBeenCalledWith('VOL', false);
    });
  });

  describe('signal score overlay', () => {
    const overlay = (over: Partial<NonNullable<React.ComponentProps<typeof TradingChart>['signalOverlay']>> = {}) => ({
      visible: true,
      recorded: new Map(),
      provisional: null,
      state: null,
      ...over,
    });
    const pane = { paneId: 'signal_score_pane', name: 'SIGNAL_SCORE' };

    it('creates no pane without the prop or when not visible', () => {
      const { rerender } = render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      rerender(<TradingChart symbol="BTCUSDT" interval="1h" signalOverlay={overlay({ visible: false })} />);
      expect(mockCreateIndicator).not.toHaveBeenCalledWith('SIGNAL_SCORE', expect.anything(), expect.anything());
      expect(mockOverrideIndicator).not.toHaveBeenCalled();
      expect(mockRemoveIndicator).not.toHaveBeenCalledWith(pane);
    });

    it('creates the pane when visible and keeps the default indicators', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" signalOverlay={overlay()} />);
      expect(mockRegisterIndicator).toHaveBeenCalled();
      expect(mockCreateIndicator).toHaveBeenCalledWith('SIGNAL_SCORE', false, { id: 'signal_score_pane', height: 140 });
      expect(mockCreateIndicator).toHaveBeenCalledWith('MA', true, { id: 'candle_pane' });
      expect(mockCreateIndicator).toHaveBeenCalledWith('VOL', false);
    });

    it('removes the pane when it stops being visible', () => {
      const { rerender } = render(<TradingChart symbol="BTCUSDT" interval="1h" signalOverlay={overlay()} />);
      rerender(<TradingChart symbol="BTCUSDT" interval="1h" signalOverlay={overlay({ visible: false })} />);
      expect(mockRemoveIndicator).toHaveBeenCalledWith(pane);
    });

    it('passes a new calc to overrideIndicator on every overlay change', () => {
      const recorded = new Map();
      const { rerender } = render(
        <TradingChart symbol="BTCUSDT" interval="1h" signalOverlay={overlay({ recorded })} />
      );
      const calls = () => mockOverrideIndicator.mock.calls.map((c) => c[0]);
      expect(calls().at(-1)).toMatchObject({ name: 'SIGNAL_SCORE', calc: expect.any(Function) });
      const first = calls().at(-1).calc;

      rerender(
        <TradingChart symbol="BTCUSDT" interval="1h" signalOverlay={overlay({ recorded, state: 'provisional' })} />
      );
      const second = calls().at(-1).calc;
      expect(second).not.toBe(first);

      rerender(
        <TradingChart symbol="BTCUSDT" interval="1h" signalOverlay={overlay({ recorded: new Map(), state: 'provisional' })} />
      );
      expect(calls().at(-1).calc).not.toBe(second);
    });

    it('does not override again when nothing changed', () => {
      const recorded = new Map();
      const { rerender } = render(<TradingChart symbol="BTCUSDT" interval="1h" signalOverlay={overlay({ recorded })} />);
      const count = mockOverrideIndicator.mock.calls.length;
      rerender(<TradingChart symbol="BTCUSDT" interval="1h" signalOverlay={overlay({ recorded })} />);
      expect(mockOverrideIndicator.mock.calls.length).toBe(count);
    });
  });

  describe('history paging', () => {
    const HOUR = 3_600_000;
    const T = Date.UTC(2026, 9, 1);
    const loader = () => mockSetDataLoader.mock.calls[0][0];
    const apiBars = (n: number, last: number) =>
      Array.from({ length: n }, (_, i) => ({ timestamp: last - (n - 1 - i) * HOUR, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }));
    const params = (type: string, timestamp: number | null) => ({
      type,
      timestamp,
      symbol: { ticker: 'BTCUSDT' },
      period: { type: 'hour', span: 1 },
      callback: vi.fn(),
    });

    it('lets older pages load after the first page and reports the loaded range', async () => {
      const onLoaded = vi.fn();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(apiBars(500, T))));
      mockGetDataList.mockReturnValue(apiBars(500, T));
      render(<TradingChart symbol="BTCUSDT" interval="1h" onLoadedRangeChange={onLoaded} />);
      const p = params('init', null);
      await loader().getBars(p);
      expect(p.callback).toHaveBeenCalledWith(expect.any(Array), { forward: true, backward: false });
      expect(onLoaded).toHaveBeenCalledWith({ from: T - 499 * HOUR, to: T });
    });

    it("asks for the page before the first bar on a 'forward' load (KlineCharts' older direction)", async () => {
      const onLoaded = vi.fn();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify(apiBars(1000, T - 500 * HOUR))));
      mockGetDataList.mockReturnValue(apiBars(1500, T));
      render(<TradingChart symbol="BTCUSDT" interval="1h" onLoadedRangeChange={onLoaded} />);
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
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      const p = params('forward', T - 499 * HOUR);
      await loader().getBars(p);
      expect(p.callback).toHaveBeenCalledWith(expect.any(Array), { forward: false });
    });

    it('drops an older page that arrives after the user switched interval', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(apiBars(1000, T - 500 * HOUR))));
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      const p = params('forward', T - 499 * HOUR);
      mockGetPeriod.mockReturnValueOnce({ type: 'minute', span: 5 });
      await loader().getBars(p);
      expect(p.callback).not.toHaveBeenCalled();
    });

    it('keeps paging on after a failed page, and never loads newer than the live bar', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 429 }));
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);
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
      period: { type: 'hour', span: 1 },
      callback: vi.fn(),
    });

    it('shows alert when init load fails and clicking retry resets data and clears alert', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      const p = params('init', null);
      await act(async () => {
        await loader().getBars(p);
      });
      expect(p.callback).toHaveBeenCalledWith([], false);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Could not load price history.');

      const retryButton = screen.getByRole('button', { name: 'Retry' });
      act(() => {
        fireEvent.click(retryButton);
      });
      expect(mockResetData).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows no alert on a successful init load', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(apiBars(500, T))));
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      const p = params('init', null);
      await act(async () => {
        await loader().getBars(p);
      });
      expect(p.callback).toHaveBeenCalledWith(expect.any(Array), { forward: true, backward: false });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('past calls overlay', () => {
    const T = Date.UTC(2026, 9, 1);
    const call = { t: T, dir: 1 as const, outcome: 'won' as const, source: 'rescore' as const, score: 31, tier: 'buy' as const, fwd: 0.5 };
    const calls = new Map([[T, call]]);
    const overlay = (over: Record<string, unknown> = {}) => ({
      visible: true,
      calls,
      boundary: T + 3_600_000,
      horizonBars: 24,
      costPercent: 0.16,
      ...over,
    });

    it('stacks the calls on the price pane and removes them when hidden', () => {
      const { rerender } = render(<TradingChart symbol="BTCUSDT" interval="1h" callsOverlay={overlay()} />);
      expect(mockCreateIndicator).toHaveBeenCalledWith('SIGNAL_CALLS', true, { id: 'candle_pane' });
      rerender(<TradingChart symbol="BTCUSDT" interval="1h" callsOverlay={overlay({ visible: false })} />);
      expect(mockRemoveIndicator).toHaveBeenCalledWith({ paneId: 'candle_pane', name: 'SIGNAL_CALLS' });
    });

    it('passes the calls as a new calc and the boundary and horizon as redraw data', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" callsOverlay={overlay()} />);
      const last = mockOverrideIndicator.mock.calls.map((c) => c[0]).filter((o) => o.name === 'SIGNAL_CALLS').at(-1);
      expect(last).toMatchObject({
        calc: expect.any(Function),
        extendData: { boundary: T + 3_600_000, hover: null, horizonBars: 24 },
      });
    });

    it('creates nothing without the prop', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      expect(mockCreateIndicator).not.toHaveBeenCalledWith('SIGNAL_CALLS', expect.anything(), expect.anything());
    });

    it('marks the call under the crosshair for its span, and clears it on leaving', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" callsOverlay={overlay()} />);
      const handler = mockSubscribeAction.mock.calls.find((c) => c[0] === 'onCrosshairChange')?.[1];
      const callsOverrides = () => mockOverrideIndicator.mock.calls.map((c) => c[0]).filter((o) => o.name === 'SIGNAL_CALLS');
      act(() => handler({ kLineData: { timestamp: T, open: 1, high: 1, low: 1, close: 1 } }));
      expect(callsOverrides().at(-1)).toEqual({
        name: 'SIGNAL_CALLS',
        extendData: { boundary: T + 3_600_000, horizonBars: 24, hover: T },
      });
      const count = callsOverrides().length;
      act(() => handler({ kLineData: { timestamp: T, open: 1, high: 1, low: 1, close: 1 } }));
      expect(callsOverrides()).toHaveLength(count);
      act(() => handler({ kLineData: { timestamp: T + 7_200_000, open: 1, high: 1, low: 1, close: 1 } }));
      expect(callsOverrides().at(-1)?.extendData.hover).toBeNull();
    });

    it('describes the hovered call in the strip under the chart, with a hint otherwise', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" callsOverlay={overlay()} />);
      const strip = screen.getByTestId('call-detail');
      expect(strip).toHaveTextContent('Hover or touch a call mark to see its score and how it ended.');
      const handler = mockSubscribeAction.mock.calls.find((c) => c[0] === 'onCrosshairChange')?.[1];
      act(() => handler({ kLineData: { timestamp: T, open: 1, high: 1, low: 1, close: 1 } }));
      expect(strip).toHaveTextContent(
        'Buy call (Long score) · re-scored, not live · score 31.0 · price +0.50% over 24 bars · +0.34% after 0.16% costs · won after costs'
      );
    });

    it('resolves the hovered bar from the pointer x, since the action carries no kLineData', () => {
      const list = [0, 1, 2].map((i) => ({ timestamp: T + (i - 1) * 3_600_000, open: 1, high: 1, low: 1, close: 1 }));
      mockGetDataList.mockReturnValue(list);
      mockConvertFromPixel.mockReturnValue([{ dataIndex: 1, timestamp: T }]);
      render(<TradingChart symbol="BTCUSDT" interval="1h" callsOverlay={overlay()} />);
      const handler = mockSubscribeAction.mock.calls.find((c) => c[0] === 'onCrosshairChange')?.[1];
      act(() => handler({ x: 420, y: 80, paneId: 'candle_pane' }));
      expect(mockConvertFromPixel).toHaveBeenCalledWith([{ x: 420 }], { paneId: 'candle_pane' });
      expect(screen.getByTestId('call-detail')).toHaveTextContent('Buy call (Long score)');
    });

    it('has no call strip without the overlay', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      expect(screen.queryByTestId('call-detail')).toBeNull();
    });

    it('reports the visible window by open time after scrolling settles', () => {
      vi.useFakeTimers();
      try {
        const onVisible = vi.fn();
        const list = [0, 1, 2, 3, 4].map((i) => ({ timestamp: T + i * 3_600_000, open: 1, high: 1, low: 1, close: 1 }));
        mockGetDataList.mockReturnValue(list);
        mockGetVisibleRange.mockReturnValue({ from: 1, to: 4, realFrom: 1.4, realTo: 3.6 });
        render(<TradingChart symbol="BTCUSDT" interval="1h" onVisibleRangeChange={onVisible} />);
        const handler = mockSubscribeAction.mock.calls.find((c) => c[0] === 'onVisibleRangeChange')?.[1];
        handler();
        handler();
        expect(onVisible).not.toHaveBeenCalled();
        vi.advanceTimersByTime(250);
        expect(onVisible).toHaveBeenCalledTimes(1);
        expect(onVisible).toHaveBeenCalledWith({ from: T + 3_600_000, to: T + 3 * 3_600_000 });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('indicator toggling', () => {
    it('calls createIndicator when enabling an indicator via dropdown', async () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      // Open the dropdown - Radix requires pointer-down for menus
      const trigger = screen.getByRole('button', { name: /indicators/i });
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });

      // Wait for dropdown content to appear
      const rsiItem = await screen.findByRole('menuitemcheckbox', { name: 'RSI' });
      fireEvent.click(rsiItem);

      expect(mockCreateIndicator).toHaveBeenCalledWith('RSI', false);
    });

    it('enabling RSI, then disabling it, calls removeIndicator({ name: "RSI" })', async () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      const trigger = screen.getByRole('button', { name: /indicators/i });
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });

      const rsiItem = await screen.findByRole('menuitemcheckbox', { name: 'RSI' });
      fireEvent.click(rsiItem);
      expect(mockCreateIndicator).toHaveBeenCalledWith('RSI', false);

      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
      const rsiItemAgain = await screen.findByRole('menuitemcheckbox', { name: 'RSI' });
      fireEvent.click(rsiItemAgain);
      expect(mockRemoveIndicator).toHaveBeenCalledWith({ name: 'RSI' });
    });

    it('calls removeIndicator when disabling an indicator via dropdown', async () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      const trigger = screen.getByRole('button', { name: /indicators/i });
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });

      const maItem = await screen.findByRole('menuitemcheckbox', { name: 'Moving Average' });
      fireEvent.click(maItem);

      expect(mockRemoveIndicator).toHaveBeenCalledWith({ paneId: 'candle_pane', name: 'MA' });
    });

    it('calls removeIndicator when disabling the default Volume indicator', async () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      const trigger = screen.getByRole('button', { name: /indicators/i });
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });

      const volItem = await screen.findByRole('menuitemcheckbox', { name: 'Volume' });
      fireEvent.click(volItem);

      expect(mockRemoveIndicator).toHaveBeenCalledWith({ name: 'VOL' });
    });
  });

  describe('drawing tools', () => {
    it('calls createOverlay with name and mode when clicking a drawing tool', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      fireEvent.click(screen.getByLabelText('Trendline'));

      expect(mockCreateOverlay).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'segment',
          mode: 'normal',
        })
      );
    });

    it('calls removeOverlay and clearOverlays when clicking clear drawings', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      fireEvent.click(screen.getByLabelText('Clear drawings'));

      expect(mockRemoveOverlay).toHaveBeenCalled();
      expect(mockClearOverlays).toHaveBeenCalledWith('BTCUSDT');
    });

    it('toggles magnet mode when clicking magnet button', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      // Initially normal mode
      expect(screen.getByLabelText('Enable magnet mode')).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('Enable magnet mode'));

      // After click, magnet is enabled
      expect(screen.getByLabelText('Disable magnet mode')).toBeInTheDocument();
    });

    it('passes weak_magnet mode to createOverlay when magnet is enabled', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      // Enable magnet mode
      fireEvent.click(screen.getByLabelText('Enable magnet mode'));

      // Click a drawing tool
      fireEvent.click(screen.getByLabelText('Ray'));

      expect(mockCreateOverlay).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'rayLine',
          mode: 'weak_magnet',
        })
      );
    });

    it('loads saved overlays on mount', () => {
      mockLoadOverlays.mockReturnValue([
        { name: 'segment', points: [{ timestamp: 1000, value: 50 }] },
      ]);

      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      expect(mockLoadOverlays).toHaveBeenCalledWith('BTCUSDT');
      expect(mockCreateOverlay).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'segment',
          points: [{ timestamp: 1000, value: 50 }],
        })
      );
    });

    it('has 8 drawing tools defined', () => {
      expect(DRAWING_TOOLS).toHaveLength(8);
    });
  });

  describe('interval change', () => {
    it('calls onIntervalChange when a tab is clicked', async () => {
      const user = userEvent.setup();
      const onIntervalChange = vi.fn();
      render(<TradingChart symbol="BTCUSDT" interval="1h" onIntervalChange={onIntervalChange} />);

      const tab = screen.getByRole('tab', { name: '5m' });
      await user.click(tab);

      expect(onIntervalChange).toHaveBeenCalledWith('5m');
    });

    it('controls active tab state and leaves no primary tab active when More interval is selected', () => {
      const { rerender } = render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      expect(screen.getByRole('tab', { name: '1H' })).toHaveAttribute('data-state', 'active');

      rerender(<TradingChart symbol="BTCUSDT" interval="1w" />);
      const activeTabs = screen.getAllByRole('tab').filter((t) => t.getAttribute('data-state') === 'active');
      expect(activeTabs).toHaveLength(0);

      rerender(<TradingChart symbol="BTCUSDT" interval="4h" />);
      expect(screen.getByRole('tab', { name: '4H' })).toHaveAttribute('data-state', 'active');
    });
  });

  describe('loading state', () => {
    it('shows loading overlay text', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      expect(screen.getByText('Loading market data...')).toBeInTheDocument();
    });
  });

  describe('cleanup', () => {
    it('calls dispose() on unmount', () => {
      const { unmount } = render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      unmount();

      expect(mockDispose).toHaveBeenCalled();
    });

    it('unsubscribes the live stream on unmount', () => {
      const { unmount } = render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      const loader = mockSetDataLoader.mock.calls[mockSetDataLoader.mock.calls.length - 1][0];
      loader.subscribeBar({
        symbol: { ticker: 'BTCUSDT' },
        period: { type: 'hour', span: 1 },
        callback: vi.fn(),
      });
      expect(mockUnsub).not.toHaveBeenCalled();
      unmount();
      expect(mockUnsub).toHaveBeenCalledTimes(1);
    });
  });

  describe('chart type selector', () => {
    it('renders chart type dropdown with default "Candles" label', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      expect(screen.getByRole('button', { name: /candles/i })).toBeInTheDocument();
    });

    it('renders chart type options in dropdown', async () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      const trigger = screen.getByRole('button', { name: /candles/i });
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });

      expect(await screen.findByRole('menuitem', { name: 'Candles' })).toBeInTheDocument();
      expect(await screen.findByRole('menuitem', { name: 'Hollow' })).toBeInTheDocument();
      expect(await screen.findByRole('menuitem', { name: 'OHLC' })).toBeInTheDocument();
      expect(await screen.findByRole('menuitem', { name: 'Area' })).toBeInTheDocument();
    });

    it('calls onChartTypeChange when a chart type is selected', async () => {
      const onChartTypeChange = vi.fn();
      render(<TradingChart symbol="BTCUSDT" interval="1h" onChartTypeChange={onChartTypeChange} />);

      const trigger = screen.getByRole('button', { name: /candles/i });
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });

      const ohlcItem = await screen.findByRole('menuitem', { name: 'OHLC' });
      fireEvent.click(ohlcItem);

      expect(onChartTypeChange).toHaveBeenCalledWith('ohlc');
    });

    it('calls setStyles when chartType prop changes', () => {
      const { rerender } = render(<TradingChart symbol="BTCUSDT" interval="1h" chartType="candle_solid" />);

      mockSetStyles.mockClear();
      rerender(<TradingChart symbol="BTCUSDT" interval="1h" chartType="area" />);

      expect(mockSetStyles).toHaveBeenCalledWith({ candle: { type: 'area' } });
    });

    it('shows current chart type label', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" chartType="ohlc" />);

      expect(screen.getByRole('button', { name: /ohlc/i })).toBeInTheDocument();
    });
  });

  describe('crosshair legend', () => {
    it('subscribes to onCrosshairChange on mount', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      expect(mockSubscribeAction).toHaveBeenCalledWith('onCrosshairChange', expect.any(Function));
    });

    it('unsubscribes from onCrosshairChange on unmount', () => {
      const { unmount } = render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      unmount();
      expect(mockUnsubscribeAction).toHaveBeenCalledWith('onCrosshairChange', expect.any(Function));
    });
  });

  describe('fullscreen mode', () => {
    it('renders fullscreen button', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      expect(screen.getByLabelText('Enter fullscreen')).toBeInTheDocument();
    });

    it('calls requestFullscreen when clicking fullscreen button', async () => {
      const mockRequestFullscreen = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(document, 'fullscreenEnabled', { value: true, writable: true, configurable: true });
      Object.defineProperty(document, 'fullscreenElement', { value: null, writable: true, configurable: true });
      Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
        value: mockRequestFullscreen,
        writable: true,
        configurable: true,
      });

      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Enter fullscreen'));
      });
      expect(mockRequestFullscreen).toHaveBeenCalled();
    });

    it('updates aria-label based on fullscreen state', () => {
      const { container } = render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      const wrapperDiv = container.firstChild as HTMLElement;

      // Initially not fullscreen
      expect(screen.getByLabelText('Enter fullscreen')).toBeInTheDocument();

      // Simulate fullscreenchange event
      Object.defineProperty(document, 'fullscreenElement', { value: wrapperDiv, writable: true, configurable: true });
      fireEvent(document, new Event('fullscreenchange'));

      expect(screen.getByLabelText('Exit fullscreen')).toBeInTheDocument();

      // Reset
      Object.defineProperty(document, 'fullscreenElement', { value: null, writable: true, configurable: true });
      fireEvent(document, new Event('fullscreenchange'));
      expect(screen.getByLabelText('Enter fullscreen')).toBeInTheDocument();
    });

    it('falls back to CSS overlay when requestFullscreen rejects, and Escape removes it', async () => {
      Object.defineProperty(document, 'fullscreenEnabled', { value: true, writable: true, configurable: true });
      Object.defineProperty(document, 'fullscreenElement', { value: null, writable: true, configurable: true });
      const mockReject = vi.fn().mockRejectedValue(new Error('Permission denied'));
      Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
        value: mockReject,
        writable: true,
        configurable: true,
      });

      const { container } = render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      const wrapper = container.firstChild as HTMLElement;

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Enter fullscreen'));
      });

      expect(wrapper.className).toContain('fixed inset-0');
      expect(screen.getByLabelText('Exit fullscreen')).toBeInTheDocument();

      act(() => {
        fireEvent.keyDown(window, { key: 'Escape' });
      });

      expect(wrapper.className).not.toContain('fixed inset-0');
      expect(screen.getByLabelText('Enter fullscreen')).toBeInTheDocument();
    });

    it('keeps wrapper class off when requestFullscreen resolves in native mode', async () => {
      Object.defineProperty(document, 'fullscreenEnabled', { value: true, writable: true, configurable: true });
      Object.defineProperty(document, 'fullscreenElement', { value: null, writable: true, configurable: true });
      const mockResolve = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
        value: mockResolve,
        writable: true,
        configurable: true,
      });

      const { container } = render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      const wrapper = container.firstChild as HTMLElement;

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Enter fullscreen'));
      });

      expect(mockResolve).toHaveBeenCalled();
      expect(wrapper.className).not.toContain('fixed inset-0');
    });
  });

  describe('CHART_TYPES constant', () => {
    it('has 4 chart types', () => {
      expect(CHART_TYPES).toHaveLength(4);
    });

    it('includes candle_solid, candle_stroke, ohlc, and area', () => {
      const values = CHART_TYPES.map((t) => t.value);
      expect(values).toEqual(['candle_solid', 'candle_stroke', 'ohlc', 'area']);
    });
  });
  describe('forming bar stream', () => {
    function openStream() {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      const loader = mockSetDataLoader.mock.calls[mockSetDataLoader.mock.calls.length - 1][0];
      const callback = vi.fn();
      loader.subscribeBar({
        symbol: { ticker: 'BTCUSDT' },
        period: { type: 'hour', span: 1 },
        callback,
      });
      const subscription = captured[captured.length - 1];
      const onFrame = subscription?.onFrame;
      return { loader, callback, onFrame, subscription };
    }

    const kline = (over: Record<string, unknown> = {}) => ({
      t: 1000,
      o: '1',
      h: '2',
      l: '0.5',
      c: '1.5',
      v: '10',
      V: '4',
      x: false,
      ...over,
    });

    beforeEach(() => useFormingBarStore.getState().reset());

    it('pushes a matching event and keeps the chart callback unchanged', () => {
      const { callback, onFrame } = openStream();
      onFrame?.({ stream: 'btcusdt@kline_1h', data: { k: kline() } });

      expect(callback).toHaveBeenCalledWith({
        timestamp: 1000,
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 10,
        takerBuyVolume: 4,
      });
      const event = useFormingBarStore.getState().latest;
      expect(event).toMatchObject({
        symbol: 'BTCUSDT',
        interval: '1h',
        closed: false,
        bar: { openTime: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, takerBuyVolume: 4 },
      });
      expect(event?.receivedAt).toBeTypeOf('number');
    });

    it('flags the final message as closed', () => {
      const { onFrame } = openStream();
      onFrame?.({ stream: 'btcusdt@kline_1h', data: { k: kline({ x: true }) } });
      expect(useFormingBarStore.getState().latest?.closed).toBe(true);
    });

    it('does not push when a number is not finite, but still feeds the chart', () => {
      const { callback, onFrame } = openStream();
      onFrame?.({ stream: 'btcusdt@kline_1h', data: { k: kline({ V: 'abc' }) } });
      expect(callback).toHaveBeenCalledTimes(1);
      expect(useFormingBarStore.getState().latest).toBeNull();
    });

    it('resets the store on unsubscribeBar', () => {
      const { loader, onFrame } = openStream();
      onFrame?.({ stream: 'btcusdt@kline_1h', data: { k: kline() } });
      expect(useFormingBarStore.getState().latest).not.toBeNull();
      loader.unsubscribeBar();
      expect(useFormingBarStore.getState().latest).toBeNull();
    });

    it('the subscribed stream list is exactly [btcusdt@kline_1h]', () => {
      const { subscription } = openStream();
      expect(subscription.streams).toEqual(['btcusdt@kline_1h']);
    });

    it('a frame for ethusdt@kline_1h reaches neither the chart callback nor the store', () => {
      const { callback, onFrame } = openStream();
      onFrame?.({ stream: 'ethusdt@kline_1h', data: { k: kline() } });
      expect(callback).not.toHaveBeenCalled();
      expect(useFormingBarStore.getState().latest).toBeNull();
    });

    it('a second subscribeBar call unsubscribes the first before subscribing again', () => {
      const { loader } = openStream();
      expect(mockUnsub).not.toHaveBeenCalled();
      loader.subscribeBar({
        symbol: { ticker: 'BTCUSDT' },
        period: { type: 'minute', span: 5 },
        callback: vi.fn(),
      });
      expect(mockUnsub).toHaveBeenCalledTimes(1);
      expect(captured.at(-1)?.streams).toEqual(['btcusdt@kline_5m']);
    });

    it('subscribeBar with period: { type: "month", span: 1 } subscribes to btcusdt@kline_1M', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1M" />);
      const loader = mockSetDataLoader.mock.calls[mockSetDataLoader.mock.calls.length - 1][0];
      loader.subscribeBar({
        symbol: { ticker: 'BTCUSDT' },
        period: { type: 'month', span: 1 },
        callback: vi.fn(),
      });
      expect(captured.at(-1)?.streams).toEqual(['btcusdt@kline_1M']);
    });

    it('unsubscribeBar calls unsub', () => {
      const { loader } = openStream();
      expect(mockUnsub).not.toHaveBeenCalled();
      loader.unsubscribeBar();
      expect(mockUnsub).toHaveBeenCalledTimes(1);
    });
  });

  describe('market prop and taker-buy volume', () => {
    const T = Date.UTC(2026, 9, 1);

    it('with market="perp", the history fetch URL contains market=perp, and the kline subscription goes through the perp client', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify([{ timestamp: T, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]))
      );
      render(<TradingChart symbol="BTCUSDT" interval="1h" market="perp" />);

      expect(mockUseMarketStreamStatus).toHaveBeenCalledWith('perp');

      const loader = mockSetDataLoader.mock.calls[mockSetDataLoader.mock.calls.length - 1][0];
      const pInit = {
        type: 'init',
        timestamp: null,
        symbol: { ticker: 'BTCUSDT' },
        period: { type: 'hour', span: 1 },
        callback: vi.fn(),
      };
      await act(async () => {
        await loader.getBars(pInit);
      });

      expect(fetchSpy).toHaveBeenCalled();
      const initUrl = String(fetchSpy.mock.calls[0][0]);
      expect(initUrl).toContain('market=perp');

      const pForward = {
        type: 'forward',
        timestamp: T,
        symbol: { ticker: 'BTCUSDT' },
        period: { type: 'hour', span: 1 },
        callback: vi.fn(),
      };
      await act(async () => {
        await loader.getBars(pForward);
      });
      const forwardUrl = String(fetchSpy.mock.calls[1][0]);
      expect(forwardUrl).toContain('market=perp');

      const barCallback = vi.fn();
      loader.subscribeBar({
        symbol: { ticker: 'BTCUSDT' },
        period: { type: 'hour', span: 1 },
        callback: barCallback,
      });

      expect(mockPerpClient.subscribe).toHaveBeenCalledTimes(1);
      expect(mockSpotClient.subscribe).not.toHaveBeenCalled();
      expect(capturedPerp.at(-1)?.streams).toEqual(['btcusdt@kline_1h']);
    });

    it('without the prop, the URL has no market param, and the spot client is used', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify([{ timestamp: T, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]))
      );
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      expect(mockUseMarketStreamStatus).toHaveBeenCalledWith('spot');

      const loader = mockSetDataLoader.mock.calls[mockSetDataLoader.mock.calls.length - 1][0];
      const pInit = {
        type: 'init',
        timestamp: null,
        symbol: { ticker: 'BTCUSDT' },
        period: { type: 'hour', span: 1 },
        callback: vi.fn(),
      };
      await act(async () => {
        await loader.getBars(pInit);
      });

      expect(fetchSpy).toHaveBeenCalled();
      const initUrl = String(fetchSpy.mock.calls[0][0]);
      expect(initUrl).not.toContain('market=');

      const pForward = {
        type: 'forward',
        timestamp: T,
        symbol: { ticker: 'BTCUSDT' },
        period: { type: 'hour', span: 1 },
        callback: vi.fn(),
      };
      await act(async () => {
        await loader.getBars(pForward);
      });
      const forwardUrl = String(fetchSpy.mock.calls[1][0]);
      expect(forwardUrl).not.toContain('market=');

      const barCallback = vi.fn();
      loader.subscribeBar({
        symbol: { ticker: 'BTCUSDT' },
        period: { type: 'hour', span: 1 },
        callback: barCallback,
      });

      expect(mockSpotClient.subscribe).toHaveBeenCalledTimes(1);
      expect(mockPerpClient.subscribe).not.toHaveBeenCalled();
      expect(capturedSpot.at(-1)?.streams).toEqual(['btcusdt@kline_1h']);
    });

    it('a history row with takerBuyVolume: 4.5 reaches the chart data with takerBuyVolume 4.5, and a live frame with V: 2.5 produces a bar with takerBuyVolume 2.5', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify([
            { timestamp: T, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, takerBuyVolume: 4.5 },
          ])
        )
      );
      render(<TradingChart symbol="BTCUSDT" interval="1h" market="perp" />);
      const loader = mockSetDataLoader.mock.calls[mockSetDataLoader.mock.calls.length - 1][0];

      const pInit = {
        type: 'init',
        timestamp: null,
        symbol: { ticker: 'BTCUSDT' },
        period: { type: 'hour', span: 1 },
        callback: vi.fn(),
      };
      await act(async () => {
        await loader.getBars(pInit);
      });

      expect(pInit.callback).toHaveBeenCalledWith(
        [
          {
            timestamp: T,
            open: 1,
            high: 2,
            low: 0.5,
            close: 1.5,
            volume: 10,
            takerBuyVolume: 4.5,
          },
        ],
        { forward: true, backward: false }
      );

      const barCallback = vi.fn();
      loader.subscribeBar({
        symbol: { ticker: 'BTCUSDT' },
        period: { type: 'hour', span: 1 },
        callback: barCallback,
      });

      const onFrame = capturedPerp.at(-1)?.onFrame;
      act(() => {
        onFrame?.({
          stream: 'btcusdt@kline_1h',
          data: {
            k: {
              t: 2000,
              o: '10',
              h: '20',
              l: '5',
              c: '15',
              v: '100',
              V: '2.5',
              x: false,
            },
          },
        });
      });

      expect(barCallback).toHaveBeenCalledWith({
        timestamp: 2000,
        open: 10,
        high: 20,
        low: 5,
        close: 15,
        volume: 100,
        takerBuyVolume: 2.5,
      });
    });

    it('a row without the field produces a bar without it', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify([
            { timestamp: T, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
          ])
        )
      );
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      const loader = mockSetDataLoader.mock.calls[mockSetDataLoader.mock.calls.length - 1][0];

      const pInit = {
        type: 'init',
        timestamp: null,
        symbol: { ticker: 'BTCUSDT' },
        period: { type: 'hour', span: 1 },
        callback: vi.fn(),
      };
      await act(async () => {
        await loader.getBars(pInit);
      });

      const receivedBars = pInit.callback.mock.calls[0][0];
      expect(receivedBars[0]).toEqual({
        timestamp: T,
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 10,
      });
      expect(Object.prototype.hasOwnProperty.call(receivedBars[0], 'takerBuyVolume')).toBe(false);

      const barCallback = vi.fn();
      loader.subscribeBar({
        symbol: { ticker: 'BTCUSDT' },
        period: { type: 'hour', span: 1 },
        callback: barCallback,
      });

      const onFrame = capturedSpot.at(-1)?.onFrame;
      act(() => {
        onFrame?.({
          stream: 'btcusdt@kline_1h',
          data: {
            k: {
              t: 3000,
              o: '10',
              h: '20',
              l: '5',
              c: '15',
              v: '100',
              V: 'not-a-number',
              x: false,
            },
          },
        });
      });

      expect(barCallback).toHaveBeenCalledWith({
        timestamp: 3000,
        open: 10,
        high: 20,
        low: 5,
        close: 15,
        volume: 100,
      });
      const receivedLiveBar = barCallback.mock.calls[0][0];
      expect(Object.prototype.hasOwnProperty.call(receivedLiveBar, 'takerBuyVolume')).toBe(false);
    });
  });

  describe('focusOverlay', () => {
    const focusProp = (over: Partial<NonNullable<React.ComponentProps<typeof TradingChart>['focusOverlay']>> = {}) => ({
      intervalMs: 3_600_000,
      showInternal: false,
      showSma: false,
      showMacd: false,
      priorDay: null,
      ...over,
    });

    it('creates STRUCTURE, DELTA_VOL and CVD, and not the default VOL/MACD/RSI set', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" focusOverlay={focusProp()} />);

      expect(mockCreateIndicator).toHaveBeenCalledWith('STRUCTURE', true, { id: 'candle_pane' });
      expect(mockCreateIndicator).toHaveBeenCalledWith('DELTA_VOL', false, { id: 'delta_vol_pane', height: 90 });
      expect(mockCreateIndicator).toHaveBeenCalledWith('CVD', false, { id: 'cvd_pane', height: 80 });

      expect(mockCreateIndicator).not.toHaveBeenCalledWith('VOL', false);
      expect(mockCreateIndicator).not.toHaveBeenCalledWith('MACD', false);
      expect(mockCreateIndicator).not.toHaveBeenCalledWith('RSI', false);
      expect(mockCreateIndicator).not.toHaveBeenCalledWith('MA', true, { id: 'candle_pane' });
      expect(mockCreateIndicator).not.toHaveBeenCalledWith({ name: 'MA', calcParams: [50] }, true, { id: 'candle_pane' });
    });

    it('creates MACD when showMacd: true and creates MA with [50] when showSma: true', () => {
      render(
        <TradingChart
          symbol="BTCUSDT"
          interval="1h"
          focusOverlay={focusProp({ showMacd: true, showSma: true })}
        />
      );

      expect(mockCreateIndicator).toHaveBeenCalledWith('MACD', false);
      expect(mockCreateIndicator).toHaveBeenCalledWith({ name: 'MA', calcParams: [50] }, true, { id: 'candle_pane' });
    });

    it('creates default indicators when focusOverlay is omitted', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      expect(mockCreateIndicator).toHaveBeenCalledWith('MA', true, { id: 'candle_pane' });
      expect(mockCreateIndicator).toHaveBeenCalledWith('VOL', false);
      expect(mockCreateIndicator).not.toHaveBeenCalledWith('STRUCTURE', expect.anything(), expect.anything());
      expect(mockCreateIndicator).not.toHaveBeenCalledWith('DELTA_VOL', expect.anything(), expect.anything());
      expect(mockCreateIndicator).not.toHaveBeenCalledWith('CVD', expect.anything(), expect.anything());
    });

    it('calls overrideIndicator for STRUCTURE with fresh calc and priorDay on update', () => {
      const priorDay = { high: 100, low: 50, close: 75 };
      const { rerender } = render(
        <TradingChart symbol="BTCUSDT" interval="1h" focusOverlay={focusProp({ priorDay: null })} />
      );

      const structureOverrides = () =>
        mockOverrideIndicator.mock.calls
          .map((c) => c[0])
          .filter((o) => o.name === 'STRUCTURE');

      expect(structureOverrides().length).toBeGreaterThan(0);
      expect(structureOverrides().at(-1)).toMatchObject({
        name: 'STRUCTURE',
        calc: expect.any(Function),
        extendData: { priorDay: null },
      });

      rerender(
        <TradingChart symbol="BTCUSDT" interval="1h" focusOverlay={focusProp({ priorDay, showInternal: true })} />
      );

      expect(structureOverrides().at(-1)).toMatchObject({
        name: 'STRUCTURE',
        calc: expect.any(Function),
        extendData: { priorDay },
      });
    });

    it('removes focus indicators on cleanup', () => {
      const { rerender } = render(
        <TradingChart
          symbol="BTCUSDT"
          interval="1h"
          focusOverlay={focusProp({ showMacd: true, showSma: true })}
        />
      );

      rerender(<TradingChart symbol="BTCUSDT" interval="1h" />);

      expect(mockRemoveIndicator).toHaveBeenCalledWith({ paneId: 'candle_pane', name: 'STRUCTURE' });
      expect(mockRemoveIndicator).toHaveBeenCalledWith({ paneId: 'delta_vol_pane', name: 'DELTA_VOL' });
      expect(mockRemoveIndicator).toHaveBeenCalledWith({ paneId: 'cvd_pane', name: 'CVD' });
      expect(mockRemoveIndicator).toHaveBeenCalledWith({ paneId: 'candle_pane', name: 'MA' });
      expect(mockRemoveIndicator).toHaveBeenCalledWith({ name: 'MACD' });
    });
  });
});

