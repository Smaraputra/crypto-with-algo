import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HeroGlobe, type GlobeTick } from './HeroGlobe';

let mockGlobeProps: { ticks?: GlobeTick[]; reducedMotion?: boolean } | null = null;

vi.mock('next/dynamic', () => ({
  default: vi.fn((_importFn, options?: { loading?: (props: unknown) => React.ReactNode }) => {
    return function MockDynamic(props: { ticks?: GlobeTick[]; reducedMotion?: boolean }) {
      mockGlobeProps = props;
      return (
        <div data-testid="mock-globe-scene" data-ticks={JSON.stringify(props.ticks)}>
          {options?.loading ? options.loading(props) : null}
        </div>
      );
    };
  }),
}));

let currentTickers: Record<string, { symbol: string; lastPrice: string }> = {};

vi.mock('@/hooks/useBinanceStream', () => ({
  useBinanceTicker: vi.fn(() => ({
    tickers: currentTickers,
    isConnected: true,
  })),
}));

describe('HeroGlobe', () => {
  beforeEach(() => {
    mockGlobeProps = null;
    currentTickers = {};
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ({} as unknown as GPUCanvasContext)
    );
  });

  it('renders screen reader sentence and SVG fallback', () => {
    render(<HeroGlobe />);

    expect(
      screen.getByText('A globe that flashes with each live price update.')
    ).toBeInTheDocument();
    expect(screen.getByTestId('globe-svg-fallback')).toBeInTheDocument();
  });

  it('handles price updates: skips first value, emits dir 1 on rise and dir -1 on fall', () => {
    const { rerender } = render(<HeroGlobe />);

    expect(mockGlobeProps?.ticks).toEqual([]);

    // First value: should skip (no tick produced)
    currentTickers = {
      BTCUSDT: { symbol: 'BTCUSDT', lastPrice: '60000.00' },
    };
    rerender(<HeroGlobe />);
    expect(mockGlobeProps?.ticks).toEqual([]);

    // Price rise on BTCUSDT: produces dir 1
    currentTickers = {
      BTCUSDT: { symbol: 'BTCUSDT', lastPrice: '60500.00' },
    };
    rerender(<HeroGlobe />);
    expect(mockGlobeProps?.ticks).toHaveLength(1);
    expect(mockGlobeProps?.ticks?.[0].dir).toBe(1);

    // Price fall on BTCUSDT: produces dir -1
    currentTickers = {
      BTCUSDT: { symbol: 'BTCUSDT', lastPrice: '59800.00' },
    };
    rerender(<HeroGlobe />);
    expect(mockGlobeProps?.ticks).toHaveLength(2);
    expect(mockGlobeProps?.ticks?.[1].dir).toBe(-1);

    // First value for ETHUSDT: should skip
    currentTickers = {
      BTCUSDT: { symbol: 'BTCUSDT', lastPrice: '59800.00' },
      ETHUSDT: { symbol: 'ETHUSDT', lastPrice: '3000.00' },
    };
    rerender(<HeroGlobe />);
    expect(mockGlobeProps?.ticks).toHaveLength(2);

    // Price rise on ETHUSDT: produces dir 1
    currentTickers = {
      BTCUSDT: { symbol: 'BTCUSDT', lastPrice: '59800.00' },
      ETHUSDT: { symbol: 'ETHUSDT', lastPrice: '3050.00' },
    };
    rerender(<HeroGlobe />);
    expect(mockGlobeProps?.ticks).toHaveLength(3);
    expect(mockGlobeProps?.ticks?.[2].dir).toBe(1);
  });

  it('renders SVG fallback directly when WebGL is unavailable', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    render(<HeroGlobe />);

    expect(screen.getByTestId('globe-svg-fallback')).toBeInTheDocument();
  });
});
