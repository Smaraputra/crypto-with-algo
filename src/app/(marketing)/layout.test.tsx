import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarketingLayout from './layout';

describe('MarketingLayout', () => {
  it('renders MarketingNav, main landmark with id="main-content", and MarketingFooter', () => {
    render(
      <MarketingLayout>
        <div>Content placeholder</div>
      </MarketingLayout>
    );

    expect(screen.getByRole('link', { name: 'CryptoWithAlgo' })).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(screen.getByText('Content placeholder')).toBeInTheDocument();
    expect(
      screen.getByText('Not financial advice. Prices from Binance public market data.')
    ).toBeInTheDocument();
  });
});
