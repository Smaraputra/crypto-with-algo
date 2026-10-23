import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CostPanel } from './CostPanel';

const mockUseCostCheckMarket = vi.fn();

vi.mock('@/hooks/useCostCheck', () => ({
  useCostCheckMarket: (symbol: string, holdMinutes: number, notional: number) =>
    mockUseCostCheckMarket(symbol, holdMinutes, notional),
}));

describe('CostPanel', () => {
  const refetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders figures from fixture data', () => {
    mockUseCostCheckMarket.mockReturnValue({
      data: {
        symbol: 'BTCUSDT',
        roundTripPercent: 0.12,
        roundTripUsdt: 1.2,
        move: {
          medianPercent: 0.85,
        },
      },
      isLoading: false,
      isError: false,
      refetch,
    });

    render(<CostPanel symbol="BTCUSDT" />);

    expect(screen.getByText('What a round trip costs')).toBeInTheDocument();
    expect(screen.getByText('$1.20')).toBeInTheDocument();
    expect(screen.getByText('(0.12%)')).toBeInTheDocument();
    expect(screen.getByText('0.85%')).toBeInTheDocument();
  });

  it('handles preset change, triggers refetch query with new hold and fires callback', async () => {
    const user = userEvent.setup();
    const onHoldChange = vi.fn();

    mockUseCostCheckMarket.mockReturnValue({
      data: {
        symbol: 'BTCUSDT',
        roundTripPercent: 0.12,
        roundTripUsdt: 1.2,
        move: {
          medianPercent: 0.85,
        },
      },
      isLoading: false,
      isError: false,
      refetch,
    });

    render(<CostPanel symbol="BTCUSDT" onHoldChange={onHoldChange} />);

    expect(mockUseCostCheckMarket).toHaveBeenCalledWith('BTCUSDT', 60, 1000);

    const radio4h = screen.getByLabelText('4h');
    await user.click(radio4h);

    expect(onHoldChange).toHaveBeenCalledWith(240);
    expect(mockUseCostCheckMarket).toHaveBeenCalledWith('BTCUSDT', 240, 1000);
  });

  it('renders loading state', () => {
    mockUseCostCheckMarket.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch,
    });

    render(<CostPanel symbol="BTCUSDT" />);
    expect(screen.getByText('Loading costs.')).toBeInTheDocument();
  });

  it('renders error state and clicking Try again calls refetch', async () => {
    const user = userEvent.setup();
    mockUseCostCheckMarket.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });

    render(<CostPanel symbol="BTCUSDT" />);
    expect(screen.getByText('Costs did not load.')).toBeInTheDocument();

    const tryAgainBtn = screen.getByRole('button', { name: 'Try again' });
    await user.click(tryAgainBtn);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
