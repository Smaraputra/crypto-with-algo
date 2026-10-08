import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { VolatilityRegime } from '@/lib/costs/volatility-regime';
import { VolatilityRegimeCard } from './VolatilityRegimeCard';

function regime(overrides: Partial<VolatilityRegime> = {}): VolatilityRegime {
  return {
    symbol: 'BTCUSDT',
    day: Date.UTC(2026, 9, 7),
    dayVolPercent: 2.41,
    thresholdVolPercent: 1.98,
    percentile: 93.9,
    high: true,
    trailingDays: 180,
    ...overrides,
  };
}

describe('VolatilityRegimeCard', () => {
  it('names a high day in words and in the accent tone, never as good or bad', () => {
    render(<VolatilityRegimeCard regime={regime()} isLoading={false} problem={null} />);
    const card = screen.getByTestId('cost-check-regime');
    expect(card).toHaveTextContent(
      "High. BTC's realised volatility on 2026-10-07 (UTC) was 2.41%, at or above the 1.98% that marks the top fifth of the previous 180 days, and higher than on 94% of them."
    );
    const label = screen.getByText('High.');
    expect(label).toHaveClass('text-accent');
    expect(label.className).not.toMatch(/bullish|bearish|green|red/);
  });

  it('quotes the measured persistence and says it is not direction', () => {
    render(<VolatilityRegimeCard regime={regime({ high: false, dayVolPercent: 1.1, percentile: 46.1 })} isLoading={false} problem={null} />);
    const card = screen.getByTestId('cost-check-regime');
    expect(card).toHaveTextContent('Normal.');
    expect(card).toHaveTextContent('below the 1.98% that marks the top fifth');
    expect(card).toHaveTextContent(
      'After a top-fifth day, the next day was also in the top fifth 41% of the time, against 15% after other days (BTCUSDT, Jul 2022 to Jun 2026).'
    );
    expect(card).toHaveTextContent('in either direction');
  });

  it('says why there is no reading while loading, on a venue failure and on incomplete bars', () => {
    const { rerender } = render(<VolatilityRegimeCard regime={undefined} isLoading problem={null} />);
    expect(screen.getByTestId('cost-check-regime')).toHaveTextContent("Reading BTC's hourly bars");
    rerender(<VolatilityRegimeCard regime={undefined} isLoading={false} problem="the exchange could not be reached" />);
    expect(screen.getByTestId('cost-check-regime')).toHaveTextContent('Not available: the exchange could not be reached.');
    rerender(<VolatilityRegimeCard regime={null} isLoading={false} problem={null} />);
    expect(screen.getByTestId('cost-check-regime')).toHaveTextContent('Not measured');
  });
});
