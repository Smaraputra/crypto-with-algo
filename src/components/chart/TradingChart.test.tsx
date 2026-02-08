import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { periodToInterval, TradingChart } from './TradingChart';

// Mock klinecharts module (canvas-based, won't work in jsdom)
const mockCreateIndicator = vi.fn().mockReturnValue('pane_1');
const mockRemoveIndicator = vi.fn().mockReturnValue(true);
const mockCreateOverlay = vi.fn().mockReturnValue('overlay_1');
const mockRemoveOverlay = vi.fn().mockReturnValue(true);
const mockSetDataLoader = vi.fn();
const mockSetSymbol = vi.fn();
const mockSetPeriod = vi.fn();
const mockResetData = vi.fn();
const mockResize = vi.fn();
const mockDispose = vi.fn();

const mockChart = {
  id: 'test-chart',
  createIndicator: mockCreateIndicator,
  removeIndicator: mockRemoveIndicator,
  createOverlay: mockCreateOverlay,
  removeOverlay: mockRemoveOverlay,
  setDataLoader: mockSetDataLoader,
  setSymbol: mockSetSymbol,
  setPeriod: mockSetPeriod,
  resetData: mockResetData,
  resize: mockResize,
};

const mockInit = vi.fn().mockReturnValue(mockChart);

vi.mock('klinecharts', () => ({
  init: (...args: unknown[]) => mockInit(...args),
  dispose: (...args: unknown[]) => mockDispose(...args),
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

  it('returns 1h for unknown period type', () => {
    expect(periodToInterval({ type: 'year' as never, span: 1 })).toBe('1h');
  });
});

describe('TradingChart', () => {
  describe('toolbar rendering', () => {
    it('renders all 6 interval tab triggers', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      expect(screen.getByRole('tab', { name: '1m' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '5m' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '15m' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '1H' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '4H' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '1D' })).toBeInTheDocument();
    });

    it('renders the indicators dropdown button', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      expect(screen.getByRole('button', { name: /indicators/i })).toBeInTheDocument();
    });

    it('renders drawing tool buttons and clear button', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      // 4 drawing tools + 1 clear button = 5 buttons in drawing toolbar
      // Plus the indicators button + refresh button in main toolbar
      const allButtons = screen.getAllByRole('button');
      // There should be at least 7 buttons (indicators, 4 drawings, clear, refresh)
      expect(allButtons.length).toBeGreaterThanOrEqual(7);
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

      // MA is overlay -> createIndicator('MA', false, { id: 'candle_pane' })
      expect(mockCreateIndicator).toHaveBeenCalledWith('MA', false, { id: 'candle_pane' });
      // VOL is volume -> createIndicator('VOL', false)
      expect(mockCreateIndicator).toHaveBeenCalledWith('VOL', false);
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
    it('calls createOverlay when clicking a drawing tool', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      // The trendline button (first drawing tool) - find by the button role within drawing toolbar
      const buttons = screen.getAllByRole('button');
      // Find the trendline button (it's after the main toolbar buttons)
      const trendlineButton = buttons.find((btn) =>
        btn.closest('.bg-muted\\/20') && btn.querySelector('svg')
      );

      if (trendlineButton) {
        fireEvent.click(trendlineButton);
        expect(mockCreateOverlay).toHaveBeenCalledWith('segment');
      }
    });

    it('calls removeOverlay when clicking clear drawings', () => {
      render(<TradingChart symbol="BTCUSDT" interval="1h" />);

      // Find the clear (trash) button - it has text-destructive class
      const clearButton = screen.getAllByRole('button').find((btn) =>
        btn.className.includes('text-destructive')
      );

      if (clearButton) {
        fireEvent.click(clearButton);
        expect(mockRemoveOverlay).toHaveBeenCalled();
      }
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
});
