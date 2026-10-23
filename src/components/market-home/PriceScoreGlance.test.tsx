import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PriceScoreGlance } from './PriceScoreGlance';
import { useLatestSignalForStyle } from '@/hooks/useSignals';
import { useUIStore } from '@/stores/uiStore';

vi.mock('@/hooks/useSignals', () => ({
  useLatestSignalForStyle: vi.fn(),
}));

describe('PriceScoreGlance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ selectedSymbol: 'BTCUSDT' });
  });

  it('renders tier sentence, "No edge (measured)", and the /signals link', () => {
    vi.mocked(useLatestSignalForStyle).mockReturnValue({
      data: {
        signal: {
          _id: 'sig-1',
          symbol: 'BTCUSDT',
          interval: '1h',
          tradingStyle: 'day_trading',
          score: 45,
          tier: 'buy',
          confidence: 70,
          components: [],
          configVersion: 1,
          candleTimestamp: 1700000000,
          expiresAt: '2026-10-23T15:00:00Z',
          createdAt: '2026-10-23T14:00:00Z',
        },
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useLatestSignalForStyle>);

    const { container } = render(<PriceScoreGlance />);

    expect(
      screen.getByText('BTC reads Long score on the 1 hour score.')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Measured on years of history and found no edge after costs. Context only.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('No edge (measured)')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'Score detail' });
    expect(link).toHaveAttribute('href', '/signals');

    expect(container.textContent).not.toMatch(/stop|target|size|leverage/i);
  });

  it('renders loading state: "Loading the score."', () => {
    vi.mocked(useLatestSignalForStyle).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof useLatestSignalForStyle>);

    const { container } = render(<PriceScoreGlance />);

    expect(screen.getByText('Loading the score.')).toBeInTheDocument();
    expect(screen.getByText('No edge (measured)')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/stop|target|size|leverage/i);
  });

  it('renders no signal state: "No score for this coin yet."', () => {
    vi.mocked(useLatestSignalForStyle).mockReturnValue({
      data: { signal: null },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useLatestSignalForStyle>);

    const { container } = render(<PriceScoreGlance />);

    expect(screen.getByText('No score for this coin yet.')).toBeInTheDocument();
    expect(screen.getByText('No edge (measured)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Score detail' })).toHaveAttribute(
      'href',
      '/signals'
    );
    expect(container.textContent).not.toMatch(/stop|target|size|leverage/i);
  });

  it('renders error state: "The score did not load."', () => {
    vi.mocked(useLatestSignalForStyle).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useLatestSignalForStyle>);

    const { container } = render(<PriceScoreGlance />);

    expect(screen.getByText('The score did not load.')).toBeInTheDocument();
    expect(screen.getByText('No edge (measured)')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/stop|target|size|leverage/i);
  });
});
