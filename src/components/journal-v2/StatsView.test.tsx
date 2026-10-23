import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StatsView } from './StatsView';
import * as analyticsHooks from '@/hooks/useJournalAnalytics';
import type { JournalAnalyticsResponse } from '@/types/journal-analytics';

vi.mock('@/hooks/useJournalAnalytics', () => ({
  useJournalAnalytics: vi.fn(),
}));

vi.mock('@/lib/chart-theme', () => ({
  useChartTheme: vi.fn(() => ({
    grid: '#E2E5E9',
    crosshair: '#7C8490',
    up: '#067346',
    down: '#C21F36',
    volume: '#E4E7EB',
    text: '#0F1114',
    mutedText: '#59606B',
    line: '#E2E5E9',
    accentLine: '#067346',
  })),
}));

vi.mock('recharts', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
  };
});

const mockAnalyticsData: JournalAnalyticsResponse = {
  summary: {
    totalTrades: 42,
    wins: 25,
    losses: 17,
    winRate: 0.595, // 59.5%
    avgPnlPercent: 3.2,
    bestTrade: 15.4,
    worstTrade: -8.1,
    totalPnlPercent: 48.75,
    profitFactor: 1.85,
  },
  incompleteTradeCount: 2,
  byTag: [
    {
      tag: 'breakout',
      count: 20,
      wins: 14,
      losses: 6,
      winRate: 0.7,
      avgPnlPercent: 4.5,
    },
  ],
  byAction: [
    { action: 'buy', count: 30, percentage: 71.4 },
    { action: 'sell', count: 12, percentage: 28.6 },
  ],
  bySetupType: [
    {
      setupType: '50 SMA bounce',
      count: 15,
      wins: 10,
      losses: 5,
      winRate: 0.667,
      avgPnlPercent: 3.8,
    },
  ],
  byMarketCondition: [
    {
      condition: 'trending_up',
      count: 25,
      wins: 18,
      losses: 7,
      winRate: 0.72,
      avgPnlPercent: 5.1,
    },
  ],
  byMonth: [
    { month: '2026-08', pnlPercent: 12.5, tradeCount: 14 },
    { month: '2026-09', pnlPercent: -4.2, tradeCount: 12 },
    { month: '2026-10', pnlPercent: 18.2, tradeCount: 16 },
  ],
  bySignalTier: [],
  bySession: [
    {
      session: 'london',
      count: 18,
      wins: 12,
      winRate: 0.667,
      avgPnlPercent: 4.1,
    },
  ],
  byHour: [],
  byWeekday: [
    {
      weekday: 1, // Monday
      count: 10,
      wins: 7,
      winRate: 0.7,
      avgPnlPercent: 3.5,
    },
  ],
  byEmotion: [
    {
      emotion: 'confident',
      count: 22,
      wins: 16,
      winRate: 0.727,
      avgPnlPercent: 4.8,
    },
  ],
  byMistake: [
    {
      mistake: 'exited_early',
      count: 5,
      avgPnlPercent: 1.2,
      totalPnlPercent: -12.4,
    },
  ],
  streaks: {
    current: { type: 'win', length: 3 },
    maxWinStreak: 6,
    maxLossStreak: 4,
  },
  kellySuggestion: {
    fraction: 0.25,
    halfFraction: 0.125,
    winRate: 0.595,
    avgWinPercent: 6.2,
    avgLossPercent: 3.4,
    sampleSize: 42,
    reliable: true,
  },
};

describe('StatsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading and error section states', () => {
    vi.mocked(analyticsHooks.useJournalAnalytics).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof analyticsHooks.useJournalAnalytics>);

    const { unmount } = render(<StatsView />);
    expect(screen.getByText('Loading stats...')).toBeInTheDocument();
    unmount();

    vi.mocked(analyticsHooks.useJournalAnalytics).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof analyticsHooks.useJournalAnalytics>);

    render(<StatsView />);
    expect(screen.getByText('Failed to load journal stats.')).toBeInTheDocument();
  });

  it('renders empty state when there are 0 total trades', () => {
    vi.mocked(analyticsHooks.useJournalAnalytics).mockReturnValue({
      data: {
        ...mockAnalyticsData,
        summary: { ...mockAnalyticsData.summary, totalTrades: 0 },
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof analyticsHooks.useJournalAnalytics>);

    render(<StatsView />);
    expect(screen.getByText('No stats available yet.')).toBeInTheDocument();
  });

  it('renders key totals from fixture', () => {
    vi.mocked(analyticsHooks.useJournalAnalytics).mockReturnValue({
      data: mockAnalyticsData,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof analyticsHooks.useJournalAnalytics>);

    render(<StatsView />);

    expect(screen.getByText('42')).toBeInTheDocument(); // total trades
    expect(screen.getByText('59.5%')).toBeInTheDocument(); // win rate
    expect(screen.getByText('+48.75%')).toBeInTheDocument(); // net pnl
    expect(screen.getByText('+6.20% / -3.40%')).toBeInTheDocument(); // avg win vs loss
    expect(screen.getByText('3 wins')).toBeInTheDocument(); // current streak
    expect(screen.getByText('6 wins')).toBeInTheDocument(); // max win streak
    expect(screen.getByText('4 losses')).toBeInTheDocument(); // max loss streak
  });

  it('provides a text alternative for the monthly performance chart', () => {
    vi.mocked(analyticsHooks.useJournalAnalytics).mockReturnValue({
      data: mockAnalyticsData,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof analyticsHooks.useJournalAnalytics>);

    render(<StatsView />);

    const textAlt = screen.getByLabelText('Monthly performance text alternative');
    expect(textAlt).toBeInTheDocument();
    expect(textAlt).toHaveTextContent('2026-08: +12.50% (14 trades)');
    expect(textAlt).toHaveTextContent('2026-09: -4.20% (12 trades)');
  });

  it('renders breakdown tables with section data', () => {
    vi.mocked(analyticsHooks.useJournalAnalytics).mockReturnValue({
      data: mockAnalyticsData,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof analyticsHooks.useJournalAnalytics>);

    render(<StatsView />);

    expect(screen.getByText('50 SMA bounce')).toBeInTheDocument();
    expect(screen.getByText('breakout')).toBeInTheDocument();
    expect(screen.getByText('Confident')).toBeInTheDocument();
    expect(screen.getByText('Exited early')).toBeInTheDocument();
    expect(screen.getByText('London')).toBeInTheDocument();
    expect(screen.getByText('Monday')).toBeInTheDocument();
  });

  it('does NOT render any text matching /kelly/i in the UI', () => {
    vi.mocked(analyticsHooks.useJournalAnalytics).mockReturnValue({
      data: mockAnalyticsData,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof analyticsHooks.useJournalAnalytics>);

    const { container } = render(<StatsView />);
    const textContent = container.textContent || '';
    expect(textContent).not.toMatch(/kelly/i);
  });
});
