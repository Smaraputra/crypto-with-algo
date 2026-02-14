import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockMutate = vi.fn();

vi.mock('@/hooks/useJournal', () => ({
  useUpdateJournalEntry: vi.fn(() => ({
    mutate: mockMutate,
    isPending: false,
  })),
}));

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
);

import { CloseTradeDialog } from './CloseTradeDialog';
import type { JournalEntry } from '@/types/journal';

const baseEntry: JournalEntry = {
  _id: 'entry-1',
  userId: 'user-1',
  symbol: 'BTCUSDT',
  interval: '1h',
  signalScore: 75,
  signalTier: 'strong_buy',
  action: 'buy',
  entryPrice: 50000,
  exitPrice: null,
  outcomePnlPercent: null,
  notes: '',
  reviewedAt: null,
  tags: [],
  indicatorSnapshot: null,
  strategyId: null,
  backtestResultId: null,
  lessonsLearned: '',
  reviewHistory: [],
  setupType: '',
  marketCondition: null,
  sentiment: null,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
};

describe('CloseTradeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders trigger button', () => {
    render(<CloseTradeDialog entry={baseEntry} />);
    expect(screen.getByTestId('close-trade-trigger')).toBeInTheDocument();
    expect(screen.getByText('Close Trade')).toBeInTheDocument();
  });

  it('opens dialog on trigger click', async () => {
    render(<CloseTradeDialog entry={baseEntry} />);
    fireEvent.click(screen.getByTestId('close-trade-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('close-trade-dialog')).toBeInTheDocument();
    });
  });

  it('shows entry price in dialog', async () => {
    render(<CloseTradeDialog entry={baseEntry} />);
    fireEvent.click(screen.getByTestId('close-trade-trigger'));
    await waitFor(() => {
      expect(screen.getByText('$50,000')).toBeInTheDocument();
    });
  });

  it('shows exit price input', async () => {
    render(<CloseTradeDialog entry={baseEntry} />);
    fireEvent.click(screen.getByTestId('close-trade-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('exit-price-input')).toBeInTheDocument();
    });
  });

  it('shows P&L preview when exit price is entered', async () => {
    render(<CloseTradeDialog entry={baseEntry} />);
    fireEvent.click(screen.getByTestId('close-trade-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('exit-price-input')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('exit-price-input'), {
      target: { value: '55000' },
    });
    expect(screen.getByTestId('pnl-preview')).toHaveTextContent('+10.00%');
  });

  it('shows negative P&L for loss', async () => {
    render(<CloseTradeDialog entry={baseEntry} />);
    fireEvent.click(screen.getByTestId('close-trade-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('exit-price-input')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('exit-price-input'), {
      target: { value: '45000' },
    });
    expect(screen.getByTestId('pnl-preview')).toHaveTextContent('-10.00%');
  });

  it('disables confirm button when no exit price', async () => {
    render(<CloseTradeDialog entry={baseEntry} />);
    fireEvent.click(screen.getByTestId('close-trade-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('confirm-close-trade')).toBeDisabled();
    });
  });

  it('calls updateMutation on submit', async () => {
    render(<CloseTradeDialog entry={baseEntry} />);
    fireEvent.click(screen.getByTestId('close-trade-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('exit-price-input')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('exit-price-input'), {
      target: { value: '55000' },
    });
    fireEvent.click(screen.getByTestId('confirm-close-trade'));
    expect(mockMutate).toHaveBeenCalledWith(
      { id: 'entry-1', exitPrice: 55000 },
      expect.any(Object)
    );
  });

  it('computes P&L correctly for sell action', async () => {
    const sellEntry = { ...baseEntry, action: 'sell' as const };
    render(<CloseTradeDialog entry={sellEntry} />);
    fireEvent.click(screen.getByTestId('close-trade-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('exit-price-input')).toBeInTheDocument();
    });

    // Sell at 50000, close at 45000 = profit (price went down)
    fireEvent.change(screen.getByTestId('exit-price-input'), {
      target: { value: '45000' },
    });
    expect(screen.getByTestId('pnl-preview')).toHaveTextContent('+10.00%');
  });
});
