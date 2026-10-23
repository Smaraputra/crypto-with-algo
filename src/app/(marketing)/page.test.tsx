import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MarketingHomePage, { metadata } from './page';

vi.mock('@/hooks/usePrices', () => ({
  useTickers: () => ({
    data: [
      {
        symbol: 'BTCUSDT',
        lastPrice: '67000',
        priceChange: '500',
        priceChangePercent: '0.75',
      },
    ],
    isLoading: false,
    isError: false,
    error: null,
  }),
}));

describe('MarketingHomePage', () => {
  it('exports honest metadata', () => {
    expect(metadata.title).toBe(
      'Crypto market tracker with an open research lab | CryptoWithAlgo'
    );
    expect(metadata.description).toBeDefined();
  });

  it('renders HomePage with h1 headline and actions', () => {
    render(<MarketingHomePage />);

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'A crypto market tracker with an open research lab',
      })
    ).toBeInTheDocument();

    expect(screen.getAllByRole('link', { name: 'Create a free account' })[0]).toHaveAttribute(
      'href',
      '/register'
    );
  });

  it('does not contain banned marketing claims', () => {
    const { container } = render(<MarketingHomePage />);
    expect(container.textContent).not.toMatch(
      /guarantee|profit|beat the market|predict|accuracy|win rate|tax/i
    );
    expect(container.textContent).not.toMatch(
      /public record|public research lab|public ledger|markdown|survivorship|instant|currently validated|volume delta|frozen/i
    );
  });
});
