import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/market-home', () => ({
  MarketHome: () => <div data-testid="market-home">MarketHome</div>,
}));

import DashboardPage, { metadata } from './page';

describe('DashboardPage', () => {
  it('renders the Market screen', () => {
    render(<DashboardPage />);
    expect(screen.getByTestId('market-home')).toBeInTheDocument();
  });

  it('titles the page Market', () => {
    expect(metadata.title).toBe('Market | CryptoWithAlgo');
  });
});
