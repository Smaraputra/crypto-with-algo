import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolios: vi.fn(),
}));

vi.mock('@/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="error-boundary">{children}</div>
  ),
}));

vi.mock('@/components/portfolio/PortfolioSelector', () => ({
  PortfolioSelector: (props: { selectedId: string | null }) => (
    <div data-testid="portfolio-selector">
      {props.selectedId ?? 'none'}
    </div>
  ),
}));

vi.mock('@/components/portfolio/PortfolioSummary', () => ({
  PortfolioSummary: (props: { portfolioId: string | null }) => (
    <div data-testid="portfolio-summary">
      {props.portfolioId ?? 'none'}
    </div>
  ),
}));

vi.mock('@/components/portfolio/HoldingsList', () => ({
  HoldingsList: () => <div data-testid="holdings-list">HoldingsList</div>,
}));

vi.mock('@/components/portfolio/TransactionForm', () => ({
  TransactionForm: () => <div data-testid="transaction-form">TransactionForm</div>,
}));

import PortfolioPage from './page';
import { usePortfolios } from '@/hooks/usePortfolio';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PortfolioPage', () => {
  it('renders Portfolio heading', () => {
    vi.mocked(usePortfolios).mockReturnValue({
      data: { portfolios: [] },
    } as never);

    render(<PortfolioPage />);

    expect(screen.getByRole('heading', { name: 'Portfolio' })).toBeInTheDocument();
  });

  it('renders PortfolioSelector', () => {
    vi.mocked(usePortfolios).mockReturnValue({
      data: { portfolios: [] },
    } as never);

    render(<PortfolioPage />);

    expect(screen.getByTestId('portfolio-selector')).toBeInTheDocument();
  });

  it('renders PortfolioSummary', () => {
    vi.mocked(usePortfolios).mockReturnValue({
      data: { portfolios: [{ _id: 'p1', name: 'My Portfolio', holdingsCount: 0 }] },
    } as never);

    render(<PortfolioPage />);

    expect(screen.getByTestId('portfolio-summary')).toBeInTheDocument();
  });

  it('auto-selects first portfolio', () => {
    vi.mocked(usePortfolios).mockReturnValue({
      data: { portfolios: [{ _id: 'p1', name: 'My Portfolio', holdingsCount: 2 }] },
    } as never);

    render(<PortfolioPage />);

    expect(screen.getByTestId('portfolio-selector')).toHaveTextContent('p1');
  });
});
