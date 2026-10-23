import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VolatilityRegimeNote } from './VolatilityRegimeNote';
import type { VolatilityRegime } from '@/lib/costs/volatility-regime';

describe('VolatilityRegimeNote', () => {
  const mockRegimeData: VolatilityRegime = {
    symbol: 'BTCUSDT',
    day: Date.UTC(2026, 9, 6),
    dayVolPercent: 3.45,
    thresholdVolPercent: 2.8,
    percentile: 88,
    high: true,
    trailingDays: 180,
  };

  it('renders loading state when isLoading is true', () => {
    render(
      <VolatilityRegimeNote
        regime={{
          data: undefined,
          isLoading: true,
          problem: null,
          retry: vi.fn(),
        }}
      />
    );
    expect(screen.getByText('Loading volatility regime.')).toBeInTheDocument();
  });

  it('renders error state and retry button when problem is present', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    render(
      <VolatilityRegimeNote
        regime={{
          data: undefined,
          isLoading: false,
          problem: 'the exchange could not be reached',
          retry,
        }}
      />
    );

    expect(screen.getByText('Volatility regime did not load.')).toBeInTheDocument();
    expect(
      screen.getByText('Regime data did not load: the exchange could not be reached.')
    ).toBeInTheDocument();

    const tryAgainBtn = screen.getByRole('button', { name: 'Try again' });
    await user.click(tryAgainBtn);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('renders incomplete message when data is null', () => {
    render(
      <VolatilityRegimeNote
        regime={{
          data: null,
          isLoading: false,
          problem: null,
          retry: vi.fn(),
        }}
      />
    );
    expect(
      screen.getByText('Volatility regime data is incomplete.')
    ).toBeInTheDocument();
  });

  it('renders regime information and evidence when data is present', () => {
    const { container } = render(
      <VolatilityRegimeNote
        regime={{
          data: mockRegimeData,
          isLoading: false,
          problem: null,
          retry: vi.fn(),
        }}
      />
    );

    expect(screen.getByText('High volatility regime')).toBeInTheDocument();
    expect(screen.getByText(/Realised vol: 3\.45%/)).toBeInTheDocument();
    expect(screen.getByText(/88th percentile/)).toBeInTheDocument();
    expect(screen.getByText(/Evidence \(BTCUSDT/)).toBeInTheDocument();
    expect(screen.getByText('Context')).toBeInTheDocument();

    expect(container.textContent).not.toMatch(/\bbuy\b|\bsell\b|safe|recommend/i);
  });

  it('renders normal volatility regime when high is false', () => {
    render(
      <VolatilityRegimeNote
        regime={{
          data: { ...mockRegimeData, high: false, dayVolPercent: 1.8, percentile: 45 },
          isLoading: false,
          problem: null,
          retry: vi.fn(),
        }}
      />
    );

    expect(screen.getByText('Normal volatility regime')).toBeInTheDocument();
    expect(screen.getByText(/Realised vol: 1\.80%/)).toBeInTheDocument();
  });
});
