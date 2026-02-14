import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

const mockMutate = vi.fn();

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
  useComputeGlobalSignal: () => ({
    mutate: mockMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
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

  it('renders compute button', () => {
    render(<SignalsPage />);
    expect(screen.getByTestId('compute-button')).toHaveTextContent('Compute Now');
  });

  it('calls computeMutation.mutate with tradingStyle on compute click', () => {
    render(<SignalsPage />);
    fireEvent.click(screen.getByTestId('compute-button'));
    expect(mockMutate).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      interval: '15m',
      tradingStyle: 'day_trading',
    });
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

  it('shows empty state when no signal computed', () => {
    render(<SignalsPage />);
    expect(screen.getByText(/No signal computed yet/)).toBeInTheDocument();
  });
});
