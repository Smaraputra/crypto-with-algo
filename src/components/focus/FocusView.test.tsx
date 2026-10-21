import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusView } from './FocusView';
import { useUIStore } from '@/stores/uiStore';

const mockReplace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

let capturedChartProps: Record<string, unknown> = {};

vi.mock('./LazyFocusChart', () => ({
  LazyFocusChart: (props: Record<string, unknown>) => {
    capturedChartProps = props;
    return (
      <div
        data-testid="lazy-focus-chart"
        data-symbol={props.symbol as string}
        data-interval={props.interval as string}
      >
        <button
          data-testid="chart-interval-15m"
          onClick={() => (props.onIntervalChange as (i: string) => void)('15m')}
        >
          15m
        </button>
        <button
          data-testid="chart-interval-1h"
          onClick={() => (props.onIntervalChange as (i: string) => void)('1h')}
        >
          1h
        </button>
      </div>
    );
  },
}));

const mockMtf = vi.fn();
vi.mock('@/hooks/useFocusMtf', () => ({
  useFocusMtf: (sym: string) => mockMtf(sym),
}));

vi.mock('./MtfStrip', () => ({
  MtfStrip: () => <div data-testid="mock-mtf-strip" />,
}));

vi.mock('./BestWeHave', () => ({
  BestWeHave: () => <div data-testid="mock-best-we-have" />,
}));

vi.mock('./ScoreDirection', () => ({
  ScoreDirection: () => <div data-testid="mock-score-direction" />,
}));

vi.mock('./CoinHeadlines', () => ({
  CoinHeadlines: () => <div data-testid="mock-coin-headlines" />,
}));

vi.mock('@/components/market/SymbolSearch', () => ({
  SymbolSearch: () => <div data-testid="mock-symbol-search" />,
}));

describe('FocusView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    capturedChartProps = {};
    useUIStore.setState({
      selectedSymbol: 'BTCUSDT',
    });
    mockMtf.mockReturnValue({
      data: { priorDay: null },
      isLoading: false,
      error: null,
    });
  });

  it('the symbol from ?symbol=ethusdt becomes ETHUSDT', () => {
    mockSearchParams = new URLSearchParams('symbol=ethusdt');
    render(<FocusView />);

    expect(capturedChartProps.symbol).toBe('ETHUSDT');
    expect(screen.getByText('ETHUSDT')).toBeInTheDocument();
  });

  it('an invalid symbol falls back to the uiStore symbol', () => {
    useUIStore.setState({ selectedSymbol: 'SOLUSDT' });
    mockSearchParams = new URLSearchParams('symbol=invalid_symbol');
    render(<FocusView />);

    expect(capturedChartProps.symbol).toBe('SOLUSDT');
    expect(screen.getByText('SOLUSDT')).toBeInTheDocument();
  });

  it('the interval toggles between 15m and 1h and reaches the chart props', () => {
    render(<FocusView />);

    // Default interval is 1h
    expect(capturedChartProps.interval).toBe('1h');
    expect(capturedChartProps.intervalOptions).toEqual(['15m', '1h']);
    const initialOverlay = capturedChartProps.focusOverlay as {
      intervalMs: number;
    };
    expect(initialOverlay.intervalMs).toBe(3_600_000);

    // Toggle to 15m via onIntervalChange
    fireEvent.click(screen.getByTestId('chart-interval-15m'));
    expect(capturedChartProps.interval).toBe('15m');
    const updatedOverlay15m = capturedChartProps.focusOverlay as {
      intervalMs: number;
    };
    expect(updatedOverlay15m.intervalMs).toBe(900_000);

    // Toggle back to 1h
    fireEvent.click(screen.getByTestId('chart-interval-1h'));
    expect(capturedChartProps.interval).toBe('1h');
    const updatedOverlay1h = capturedChartProps.focusOverlay as {
      intervalMs: number;
    };
    expect(updatedOverlay1h.intervalMs).toBe(3_600_000);
  });

  it('each of the three toggles flips aria-pressed and the matching focusOverlay field', () => {
    render(<FocusView />);

    const internalBtn = screen.getByRole('button', {
      name: 'Internal structure',
    });
    const smaBtn = screen.getByRole('button', { name: '50 SMA' });
    const macdBtn = screen.getByRole('button', { name: 'MACD' });

    // Initial states: all off
    expect(internalBtn).toHaveAttribute('aria-pressed', 'false');
    expect(smaBtn).toHaveAttribute('aria-pressed', 'false');
    expect(macdBtn).toHaveAttribute('aria-pressed', 'false');
    let overlay = capturedChartProps.focusOverlay as {
      showInternal: boolean;
      showSma: boolean;
      showMacd: boolean;
    };
    expect(overlay.showInternal).toBe(false);
    expect(overlay.showSma).toBe(false);
    expect(overlay.showMacd).toBe(false);

    // Toggle Internal structure on then off
    fireEvent.click(internalBtn);
    expect(internalBtn).toHaveAttribute('aria-pressed', 'true');
    overlay = capturedChartProps.focusOverlay as typeof overlay;
    expect(overlay.showInternal).toBe(true);

    fireEvent.click(internalBtn);
    expect(internalBtn).toHaveAttribute('aria-pressed', 'false');
    overlay = capturedChartProps.focusOverlay as typeof overlay;
    expect(overlay.showInternal).toBe(false);

    // Toggle 50 SMA on then off
    fireEvent.click(smaBtn);
    expect(smaBtn).toHaveAttribute('aria-pressed', 'true');
    overlay = capturedChartProps.focusOverlay as typeof overlay;
    expect(overlay.showSma).toBe(true);

    fireEvent.click(smaBtn);
    expect(smaBtn).toHaveAttribute('aria-pressed', 'false');
    overlay = capturedChartProps.focusOverlay as typeof overlay;
    expect(overlay.showSma).toBe(false);

    // Toggle MACD on then off
    fireEvent.click(macdBtn);
    expect(macdBtn).toHaveAttribute('aria-pressed', 'true');
    overlay = capturedChartProps.focusOverlay as typeof overlay;
    expect(overlay.showMacd).toBe(true);

    fireEvent.click(macdBtn);
    expect(macdBtn).toHaveAttribute('aria-pressed', 'false');
    overlay = capturedChartProps.focusOverlay as typeof overlay;
    expect(overlay.showMacd).toBe(false);
  });

  it('the rail sections render in order', () => {
    render(<FocusView />);

    const mtf = screen.getByTestId('mock-mtf-strip');
    const best = screen.getByTestId('mock-best-we-have');
    const score = screen.getByTestId('mock-score-direction');
    const headlines = screen.getByTestId('mock-coin-headlines');

    expect(mtf).toBeInTheDocument();
    expect(best).toBeInTheDocument();
    expect(score).toBeInTheDocument();
    expect(headlines).toBeInTheDocument();

    // Verify ordering in the DOM: mtf -> best -> score -> headlines
    expect(
      mtf.compareDocumentPosition(best) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      best.compareDocumentPosition(score) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      score.compareDocumentPosition(headlines) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('priorDay from the MTF hook reaches focusOverlay', () => {
    const mockPriorDay = { high: 65000, low: 63000, close: 64000 };
    mockMtf.mockReturnValue({
      data: { priorDay: mockPriorDay },
      isLoading: false,
      error: null,
    });

    render(<FocusView />);

    const overlay = capturedChartProps.focusOverlay as {
      priorDay: { high: number; low: number; close: number } | null;
    };
    expect(overlay.priorDay).toEqual(mockPriorDay);
  });
});
