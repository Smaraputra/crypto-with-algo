import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarketingFooter } from './MarketingFooter';

describe('MarketingFooter', () => {
  it('renders privacy, terms, and docs links', () => {
    render(<MarketingFooter />);

    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs');
  });

  it('renders brand mark and the current year with copyright symbol without disclaimer', () => {
    const { container } = render(<MarketingFooter />);

    expect(screen.getByText('CryptoWithAlgo')).toBeInTheDocument();
    expect(
      screen.queryByText('Not financial advice. Prices from Binance public market data.')
    ).not.toBeInTheDocument();

    const currentYear = new Date().getFullYear().toString();
    expect(screen.getByText(new RegExp(`© ${currentYear}`))).toBeInTheDocument();

    expect(container.textContent).not.toMatch(
      /public record|public research lab|public ledger|markdown|survivorship|instant|currently validated|volume delta|frozen/i
    );
  });
});
