import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import FocusPage, { metadata } from './page';

vi.mock('@/components/coin', () => ({
  CoinStudy: ({ symbol }: { symbol?: string }) => (
    <div data-testid="coin-study" data-symbol={symbol ?? 'none'}>
      {symbol ?? 'undefined'}
    </div>
  ),
}));

describe('FocusPage', () => {
  it('has the approved metadata title', () => {
    expect(metadata.title).toBe('Coin study | CryptoWithAlgo');
  });

  it('passes through a valid symbol when searchParams is a promise', async () => {
    const pageJsx = await FocusPage({
      searchParams: Promise.resolve({ symbol: 'BTCUSDT' }),
    });

    render(pageJsx);
    const element = screen.getByTestId('coin-study');
    expect(element).toHaveAttribute('data-symbol', 'BTCUSDT');
    expect(element).toHaveTextContent('BTCUSDT');
  });

  it('passes through a valid symbol when searchParams is a plain object', async () => {
    const pageJsx = await FocusPage({
      searchParams: { symbol: 'SOLUSDT' },
    });

    render(pageJsx);
    const element = screen.getByTestId('coin-study');
    expect(element).toHaveAttribute('data-symbol', 'SOLUSDT');
  });

  it('passes undefined when symbol fails validation regex', async () => {
    const invalidSymbols = [
      'invalid',
      'btc',
      'BTC_USDT',
      'BTC',
      'BTCUSD',
      '123456789012345678901USDT', // too long (>20)
      'B!USDT',
    ];

    for (const invalid of invalidSymbols) {
      const pageJsx = await FocusPage({
        searchParams: Promise.resolve({ symbol: invalid }),
      });

      const { unmount } = render(pageJsx);
      const element = screen.getByTestId('coin-study');
      expect(element).toHaveAttribute('data-symbol', 'none');
      unmount();
    }
  });

  it('passes undefined when symbol is missing', async () => {
    const pageJsx = await FocusPage({});
    render(pageJsx);
    const element = screen.getByTestId('coin-study');
    expect(element).toHaveAttribute('data-symbol', 'none');
  });
});
