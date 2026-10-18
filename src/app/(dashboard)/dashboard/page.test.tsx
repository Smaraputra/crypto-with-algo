import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="error-boundary">{children}</div>
  ),
}));

vi.mock('@/components/market/MarketOverview', () => ({
  MarketOverview: () => <div data-testid="market-overview">MarketOverview</div>,
}));

vi.mock('@/components/chart/LazyDashboardChart', () => ({
  LazyDashboardChart: () => (
    <div data-testid="lazy-dashboard-chart">DashboardChart</div>
  ),
}));

vi.mock('@/components/market/NewsFeed', () => ({
  NewsFeed: () => <div data-testid="news-feed">NewsFeed</div>,
}));

vi.mock('@/components/market/SentimentGauge', () => ({
  SentimentGauge: () => <div data-testid="sentiment-gauge">SentimentGauge</div>,
}));

vi.mock('@/components/dashboard/WhenToLookPanel', () => ({
  WhenToLookPanel: () => <div data-testid="when-to-look-panel">WhenToLookPanel</div>,
}));

vi.mock('@/components/signals/CrossSectionalPortfolioCard', () => ({
  CrossSectionalPortfolioCard: () => (
    <div data-testid="cross-sectional-portfolio-card">CrossSectionalPortfolioCard</div>
  ),
}));

import DashboardPage from './page';
import { auth } from '@/lib/auth';

const mockAuth = vi.mocked(auth);

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Dashboard heading', async () => {
    mockAuth.mockResolvedValue(null as never);

    const jsx = await DashboardPage();
    render(jsx);

    expect(
      screen.getByRole('heading', { name: 'Dashboard' })
    ).toBeInTheDocument();
  });

  it('shows welcome with user name when session has name', async () => {
    mockAuth.mockResolvedValue({
      user: { id: '1', name: 'Alice', email: 'a@b.com' },
      expires: '',
    } as never);

    const jsx = await DashboardPage();
    render(jsx);

    expect(screen.getByText('Welcome, Alice.')).toBeInTheDocument();
  });

  it('shows generic welcome when session has no name', async () => {
    mockAuth.mockResolvedValue({
      user: { id: '1', email: 'a@b.com' },
      expires: '',
    } as never);

    const jsx = await DashboardPage();
    render(jsx);

    expect(screen.getByText('Welcome.')).toBeInTheDocument();
  });

  it('renders the when-to-look panel before MarketOverview', async () => {
    mockAuth.mockResolvedValue(null as never);

    const jsx = await DashboardPage();
    render(jsx);

    const panel = screen.getByTestId('when-to-look-panel');
    const overview = screen.getByTestId('market-overview');
    expect(panel.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders MarketOverview', async () => {
    mockAuth.mockResolvedValue(null as never);

    const jsx = await DashboardPage();
    render(jsx);

    expect(screen.getByTestId('market-overview')).toBeInTheDocument();
  });

  it('renders DashboardChart', async () => {
    mockAuth.mockResolvedValue(null as never);

    const jsx = await DashboardPage();
    render(jsx);

    expect(screen.getByTestId('lazy-dashboard-chart')).toBeInTheDocument();
  });

  it('renders CrossSectionalPortfolioCard', async () => {
    mockAuth.mockResolvedValue(null as never);

    const jsx = await DashboardPage();
    render(jsx);

    expect(screen.getByTestId('cross-sectional-portfolio-card')).toBeInTheDocument();
  });
});
