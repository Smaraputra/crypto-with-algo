import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useSentiment', () => ({
  useFearAndGreed: vi.fn(),
}));

import { SentimentGauge } from './SentimentGauge';
import { useFearAndGreed } from '@/hooks/useSentiment';

const mockUseFearAndGreed = vi.mocked(useFearAndGreed);

describe('SentimentGauge', () => {
  it('shows loading state', () => {
    mockUseFearAndGreed.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof useFearAndGreed>);

    render(<SentimentGauge />);
    expect(screen.getByTestId('sentiment-gauge-loading')).toBeInTheDocument();
  });

  it('renders nothing on error', () => {
    mockUseFearAndGreed.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useFearAndGreed>);

    const { container } = render(<SentimentGauge />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when no data', () => {
    mockUseFearAndGreed.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useFearAndGreed>);

    const { container } = render(<SentimentGauge />);
    expect(container.firstChild).toBeNull();
  });

  it('renders gauge with sentiment data', () => {
    mockUseFearAndGreed.mockReturnValue({
      data: { sentiment: { fearGreedIndex: 42, label: 'Fear' } },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useFearAndGreed>);

    render(<SentimentGauge />);
    expect(screen.getByTestId('sentiment-gauge')).toBeInTheDocument();
    expect(screen.getByText('Fear & Greed')).toBeInTheDocument();
    expect(screen.getByText('42 - Fear')).toBeInTheDocument();
  });

  it('sets gauge fill width based on index', () => {
    mockUseFearAndGreed.mockReturnValue({
      data: { sentiment: { fearGreedIndex: 75, label: 'Greed' } },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useFearAndGreed>);

    render(<SentimentGauge />);
    const fill = screen.getByTestId('gauge-fill');
    expect(fill).toHaveStyle({ width: '75%' });
  });

  it('shows extreme fear label for low index', () => {
    mockUseFearAndGreed.mockReturnValue({
      data: { sentiment: { fearGreedIndex: 10, label: 'Extreme Fear' } },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useFearAndGreed>);

    render(<SentimentGauge />);
    expect(screen.getByText('10 - Extreme Fear')).toBeInTheDocument();
  });

  it('shows extreme greed label for high index', () => {
    mockUseFearAndGreed.mockReturnValue({
      data: { sentiment: { fearGreedIndex: 90, label: 'Extreme Greed' } },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useFearAndGreed>);

    render(<SentimentGauge />);
    expect(screen.getByText('90 - Extreme Greed')).toBeInTheDocument();
  });
});
