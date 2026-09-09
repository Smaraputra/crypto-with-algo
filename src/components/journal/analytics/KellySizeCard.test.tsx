import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KellySizeCard } from './KellySizeCard';

describe('KellySizeCard', () => {
  it('shows the half-Kelly size with record stats when reliable', () => {
    render(
      <KellySizeCard
        suggestion={{
          fraction: 0.4,
          halfFraction: 0.2,
          winRate: 0.6,
          avgWinPercent: 2,
          avgLossPercent: 1,
          sampleSize: 25,
          reliable: true,
        }}
      />
    );

    expect(screen.getByTestId('kelly-suggested-size')).toHaveTextContent('20.0%');
    expect(screen.getByText(/60% win rate/)).toBeInTheDocument();
    expect(screen.getByText(/25 closed trades/)).toBeInTheDocument();
  });

  it('greys out and explains the requirement when unreliable', () => {
    render(
      <KellySizeCard
        suggestion={{
          fraction: 0,
          halfFraction: 0,
          winRate: 0.5,
          avgWinPercent: 1,
          avgLossPercent: 1,
          sampleSize: 4,
          reliable: false,
        }}
      />
    );

    expect(screen.getByTestId('kelly-suggested-size')).toHaveTextContent('--');
    expect(screen.getByText(/at least 20 closed trades/)).toBeInTheDocument();
  });
});
