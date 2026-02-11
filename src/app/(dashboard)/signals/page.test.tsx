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

  it('renders symbol selector buttons', () => {
    render(<SignalsPage />);
    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText('SOL')).toBeInTheDocument();
    expect(screen.getByText('BNB')).toBeInTheDocument();
    expect(screen.getByText('XRP')).toBeInTheDocument();
  });

  it('renders interval selector', () => {
    render(<SignalsPage />);
    expect(screen.getByTestId('interval-select')).toBeInTheDocument();
  });

  it('renders compute button', () => {
    render(<SignalsPage />);
    expect(screen.getByTestId('compute-button')).toHaveTextContent('Compute Now');
  });

  it('calls computeMutation.mutate on compute button click', () => {
    render(<SignalsPage />);
    fireEvent.click(screen.getByTestId('compute-button'));
    expect(mockMutate).toHaveBeenCalledWith({ symbol: 'BTCUSDT', interval: '1h' });
  });

  it('renders futures data section', () => {
    render(<SignalsPage />);
    expect(screen.getByText('Futures Data')).toBeInTheDocument();
  });

  it('renders signal history section', () => {
    render(<SignalsPage />);
    expect(screen.getByText('Signal History')).toBeInTheDocument();
  });

  it('shows empty state when no signal computed', () => {
    render(<SignalsPage />);
    expect(screen.getByText(/No signal computed yet/)).toBeInTheDocument();
  });
});
