import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { toast } from 'sonner';
import { LogTradeSheet } from './LogTradeSheet';
import * as journalHooks from '@/hooks/useJournal';
import * as disciplineHooks from '@/hooks/useDiscipline';
import * as symbolsHooks from '@/hooks/useSymbols';

vi.mock('@/hooks/useJournal', () => ({
  useCreateJournalEntry: vi.fn(),
}));

vi.mock('@/hooks/useDiscipline', () => ({
  useDiscipline: vi.fn(),
}));

vi.mock('@/hooks/useSymbols', () => ({
  useSymbols: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('LogTradeSheet', () => {
  const onOpenChange = vi.fn();
  const mockMutateAsync = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(symbolsHooks.useSymbols).mockReturnValue({
      data: [
        { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
        { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof symbolsHooks.useSymbols>);

    vi.mocked(disciplineHooks.useDiscipline).mockReturnValue({
      data: [
        {
          rule: 'loss_cooldown',
          severity: 'warning',
          message: '3 consecutive losses. Consider stepping away before the next trade.',
        },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof disciplineHooks.useDiscipline>);

    vi.mocked(journalHooks.useCreateJournalEntry).mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof journalHooks.useCreateJournalEntry>);
  });

  it('shows discipline nudges under "Before you log"', () => {
    render(<LogTradeSheet open={true} onOpenChange={onOpenChange} />);

    expect(screen.getByText('Before you log')).toBeInTheDocument();
    expect(
      screen.getByText('3 consecutive losses. Consider stepping away before the next trade.')
    ).toBeInTheDocument();
  });

  it('shows inline validation messages for invalid positive numbers', async () => {
    render(<LogTradeSheet open={true} onOpenChange={onOpenChange} />);

    const entryPriceInput = screen.getByLabelText('Entry price');
    fireEvent.change(entryPriceInput, { target: { value: '-10' } });

    const quantityInput = screen.getByLabelText('Quantity');
    fireEvent.change(quantityInput, { target: { value: '0' } });

    const saveButton = screen.getByRole('button', { name: 'Save trade' });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByText('Entry price must be greater than 0.')).toBeInTheDocument();
      expect(screen.getByText('Quantity must be greater than 0.')).toBeInTheDocument();
    });
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('submits correct payload, triggers "Trade saved" toast, and closes sheet', async () => {
    mockMutateAsync.mockResolvedValueOnce({ success: true });

    render(<LogTradeSheet open={true} onOpenChange={onOpenChange} initialSymbol="BTCUSDT" />);

    // Fill fields
    fireEvent.change(screen.getByLabelText('Entry price'), { target: { value: '65000' } });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByLabelText('Your planned stop'), { target: { value: '64000' } });
    fireEvent.change(screen.getByLabelText('Your planned target'), { target: { value: '67000' } });
    fireEvent.change(screen.getByLabelText('Setup'), { target: { value: 'Range breakout' } });
    fireEvent.change(screen.getByLabelText('Market condition'), { target: { value: 'trending_up' } });
    fireEvent.change(screen.getByLabelText('Session'), { target: { value: 'ny_overlap' } });
    fireEvent.change(screen.getByLabelText('Emotion before'), { target: { value: 'confident' } });
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'breakout, momentum' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Clean 4h close' } });

    const saveButton = screen.getByRole('button', { name: 'Save trade' });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTCUSDT',
        action: 'buy',
        entryPrice: 65000,
        quantity: 0.5,
        plannedStop: 64000,
        plannedTarget: 67000,
        plannedRiskReward: 2, // (67000 - 65000) / (65000 - 64000) = 2000 / 1000 = 2
        setupType: 'Range breakout',
        marketCondition: 'trending_up',
        session: 'ny_overlap',
        emotion: 'confident',
        tags: ['breakout', 'momentum'],
        notes: 'Clean 4h close',
      })
    );

    expect(toast.success).toHaveBeenCalledWith('Trade saved');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('displays server error inline when mutation fails', async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error('Network error logging trade'));

    render(<LogTradeSheet open={true} onOpenChange={onOpenChange} initialSymbol="BTCUSDT" />);

    const saveButton = screen.getByRole('button', { name: 'Save trade' });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Network error logging trade');
    });

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
