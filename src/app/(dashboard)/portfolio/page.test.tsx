import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PortfolioPage, { metadata } from './page';

vi.mock('@/components/portfolio-v2', () => ({
  PortfolioScreen: () => <div data-testid="portfolio-screen">Portfolio Screen Mock</div>,
}));

describe('PortfolioPage', () => {
  it('has the correct metadata title', () => {
    expect(metadata.title).toBe('Portfolio | CryptoWithAlgo');
  });

  it('renders PortfolioScreen inside Suspense', () => {
    render(<PortfolioPage />);
    expect(screen.getByTestId('portfolio-screen')).toBeInTheDocument();
  });
});
