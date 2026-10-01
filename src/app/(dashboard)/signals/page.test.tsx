import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

const mockMutate = vi.fn();
const mockUseTradePlan = vi.fn<(...args: unknown[]) => { data: undefined; isLoading: boolean; isError: boolean }>(
  () => ({ data: undefined, isLoading: true, isError: false })
);

vi.mock('@/hooks/useSignals', () => ({
  useSignals: () => ({ data: { signals: [] }, isLoading: false }),
  useLatestSignal: () => ({ data: null, isLoading: false }),
  useComputeSignal: () => ({
    mutate: mockMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
  useGlobalSignals: () => ({ data: { signals: [] }, isLoading: false }),
  useLatestSignals: () => ({
    data: {
      signals: {
        scalping: null,
        day_trading: null,
        swing_trading: null,
        position_trading: null,
      },
    },
    isLoading: false,
  }),
  useLatestSignalForStyle: () => ({ data: null, isLoading: false }),
  useTradePlan: (...args: unknown[]) => mockUseTradePlan(...args),
}));

vi.mock('@/components/signals/TradePlanCard', () => ({
  TradePlanCard: ({ isLoading }: { isLoading: boolean }) => (
    <div data-testid="trade-plan-card" data-loading={String(isLoading)} />
  ),
}));

vi.mock('@/hooks/useFutures', () => ({
  useFundingRate: () => ({ data: null, isLoading: false }),
  useOpenInterest: () => ({ data: null, isLoading: false }),
  useLongShortRatio: () => ({ data: null, isLoading: false }),
}));

vi.mock('@/stores/uiStore', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedSymbol: 'BTCUSDT',
      setSelectedSymbol: vi.fn(),
    }),
}));

vi.mock('@/components/signals/SignalGauge', () => ({
  SignalGauge: () => <div data-testid="signal-gauge" />,
}));

vi.mock('@/components/signals/SignalBreakdown', () => ({
  SignalBreakdown: () => <div data-testid="signal-breakdown" />,
}));

vi.mock('@/components/signals/FuturesPanel', () => ({
  FuturesPanel: () => <div data-testid="futures-panel" />,
}));

vi.mock('@/components/signals/StyleTabs', () => ({
  StyleTabs: ({ value, onValueChange }: { value: string; onValueChange: (v: string) => void }) => (
    <div data-testid="style-tabs" data-value={value}>
      <button data-testid="style-tab-scalping" onClick={() => onValueChange('scalping')}>
        Scalping
      </button>
      <button data-testid="style-tab-day_trading" onClick={() => onValueChange('day_trading')}>
        Day Trading
      </button>
    </div>
  ),
}));

vi.mock('@/components/signals/AutoUpdateStatus', () => ({
  AutoUpdateStatus: () => <div data-testid="auto-update-status" />,
}));

vi.mock('@/components/signals/SignalTimeline', () => ({
  SignalTimeline: () => <div data-testid="signal-timeline" />,
}));

vi.mock('@/components/signals/MultiStyleOverview', () => ({
  MultiStyleOverview: () => <div data-testid="multi-style-overview" />,
}));

vi.mock('@/components/journal/EnhancedJournalForm', () => ({
  EnhancedJournalForm: () => <div data-testid="enhanced-journal-form" />,
}));

vi.mock('@/hooks/useJournalAnalytics', () => ({
  useJournalAnalytics: vi.fn(() => ({ data: undefined })),
}));

vi.mock('@/hooks/useDiscipline', () => ({
  useDiscipline: vi.fn(() => ({ data: [] })),
}));

vi.mock('@/hooks/useSentiment', () => ({
  useFearAndGreed: () => ({ data: null, isLoading: false, isError: false }),
}));

vi.mock('@/components/market/SentimentGauge', () => ({
  SentimentGauge: () => <div data-testid="sentiment-gauge" />,
}));

import SignalsPage from './page';

describe('SignalsPage', () => {
  it('renders page heading', () => {
    render(<SignalsPage />);
    expect(screen.getByText('Signals')).toBeInTheDocument();
  });

  it('renders symbol selector buttons (top 10)', () => {
    render(<SignalsPage />);
    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText('SOL')).toBeInTheDocument();
    expect(screen.getByText('BNB')).toBeInTheDocument();
    expect(screen.getByText('XRP')).toBeInTheDocument();
    expect(screen.getByText('ADA')).toBeInTheDocument();
    expect(screen.getByText('DOGE')).toBeInTheDocument();
  });

  it('renders style tabs', () => {
    render(<SignalsPage />);
    expect(screen.getByTestId('style-tabs')).toBeInTheDocument();
  });

  it('renders interval selector', () => {
    render(<SignalsPage />);
    expect(screen.getByTestId('interval-select')).toBeInTheDocument();
  });

  it('offers no way to score on demand', () => {
    // "Compute Now" wrote a GlobalSignal from a browser click, which put a row
    // into the same live record the configVersion evidence is read from, at a
    // time no cron fired. Scoring belongs to the scheduler alone.
    render(<SignalsPage />);
    expect(screen.queryByTestId('compute-button')).not.toBeInTheDocument();
  });

  it('renders auto-update status', () => {
    render(<SignalsPage />);
    expect(screen.getByTestId('auto-update-status')).toBeInTheDocument();
  });

  it('renders multi-style overview', () => {
    render(<SignalsPage />);
    expect(screen.getByText('All Styles')).toBeInTheDocument();
    expect(screen.getByTestId('multi-style-overview')).toBeInTheDocument();
  });

  it('renders futures data section', () => {
    render(<SignalsPage />);
    expect(screen.getByText('Futures Data')).toBeInTheDocument();
  });

  it('renders signal history section', () => {
    render(<SignalsPage />);
    expect(screen.getByText('Signal History')).toBeInTheDocument();
    expect(screen.getByTestId('signal-timeline')).toBeInTheDocument();
  });

  it('renders the trade plan for the selected symbol, style and interval', () => {
    mockUseTradePlan.mockClear();
    render(<SignalsPage />);
    expect(screen.getByTestId('trade-plan-card')).toHaveAttribute('data-loading', 'true');
    expect(mockUseTradePlan).toHaveBeenLastCalledWith('BTCUSDT', 'day_trading', '15m');
  });

  it('asks for the trade plan of the newly selected style', () => {
    mockUseTradePlan.mockClear();
    render(<SignalsPage />);
    fireEvent.click(screen.getByTestId('style-tab-scalping'));
    expect(mockUseTradePlan).toHaveBeenLastCalledWith('BTCUSDT', 'scalping', '1m');
  });

  it('shows empty state when no signal computed', () => {
    render(<SignalsPage />);
    expect(screen.getByText(/No signal computed yet/)).toBeInTheDocument();
  });
});
