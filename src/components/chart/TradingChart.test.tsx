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

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  onopen: ((e: Event) => void) | null = null;
  onclose: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close = vi.fn();

  static resetMock() {
    MockWebSocket.instances = [];
  }
}
vi.stubGlobal('WebSocket', MockWebSocket);

beforeEach(() => {
  vi.clearAllMocks();
  MockWebSocket.resetMock();
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

afterEach(() => {
  vi.restoreAllMocks();
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

    it('calls removeIndicator when disabling an indicator via dropdown', async () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      const trigger = screen.getByRole('button', { name: /indicators/i });
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });

      const maItem = await screen.findByRole('menuitemcheckbox', { name: 'Moving Average' });
      fireEvent.click(maItem);

      expect(mockRemoveIndicator).toHaveBeenCalledWith({ paneId: 'candle_pane', name: 'MA' });
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

    it('closes WebSocket on unmount', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      // If subscribeBar was called by the DataLoader, a WS would have been created
      // The cleanup should close it
      const { unmount } = render(<TradingChart symbol="BTCUSDT" interval="1h" />);
      unmount();

      expect(mockDispose).toHaveBeenCalled();
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

    it('calls requestFullscreen when clicking fullscreen button', () => {
      const mockRequestFullscreen = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(document, 'fullscreenEnabled', { value: true, writable: true });
      Object.defineProperty(document, 'fullscreenElement', { value: null, writable: true });

      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      // Get the wrapper div and add requestFullscreen mock
      const wrapperDiv = screen.getByLabelText('Enter fullscreen').closest('.flex.h-full');
      if (wrapperDiv) {
        (wrapperDiv as HTMLElement).requestFullscreen = mockRequestFullscreen;
      }

      fireEvent.click(screen.getByLabelText('Enter fullscreen'));
      expect(mockRequestFullscreen).toHaveBeenCalled();
    });

    it('updates aria-label based on fullscreen state', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      // Initially not fullscreen
      expect(screen.getByLabelText('Enter fullscreen')).toBeInTheDocument();

      // Simulate fullscreenchange event
      Object.defineProperty(document, 'fullscreenElement', { value: document.body, writable: true });
      fireEvent(document, new Event('fullscreenchange'));

      expect(screen.getByLabelText('Exit fullscreen')).toBeInTheDocument();

      // Reset
      Object.defineProperty(document, 'fullscreenElement', { value: null, writable: true });
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
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      return { loader, callback, ws };
    }

    const kline = (over: Record<string, unknown> = {}) =>
      JSON.stringify({
        k: { t: 1000, o: '1', h: '2', l: '0.5', c: '1.5', v: '10', V: '4', x: false, ...over },
      });

    beforeEach(() => useFormingBarStore.getState().reset());

    it('pushes a matching event and keeps the chart callback unchanged', () => {
      const { callback, ws } = openStream();
      ws.onmessage?.({ data: kline() } as MessageEvent);

      expect(callback).toHaveBeenCalledWith({
        timestamp: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10,
      });
      const event = useFormingBarStore.getState().latest;
      expect(event).toMatchObject({
        symbol: 'BTCUSDT',
        interval: '1h',
        closed: false,
        bar: { openTime: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, takerBuyVolume: 4 },
      });
      expect(event?.receivedAt).toBeTypeOf('number');
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it('flags the final message as closed', () => {
      const { ws } = openStream();
      ws.onmessage?.({ data: kline({ x: true }) } as MessageEvent);
      expect(useFormingBarStore.getState().latest?.closed).toBe(true);
    });

    it('does not push when a number is not finite, but still feeds the chart', () => {
      const { callback, ws } = openStream();
      ws.onmessage?.({ data: kline({ V: 'abc' }) } as MessageEvent);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(useFormingBarStore.getState().latest).toBeNull();
    });

    it('resets the store on unsubscribeBar', () => {
      const { loader, ws } = openStream();
      ws.onmessage?.({ data: kline() } as MessageEvent);
      expect(useFormingBarStore.getState().latest).not.toBeNull();
      loader.unsubscribeBar();
      expect(useFormingBarStore.getState().latest).toBeNull();
    });
  });
});
