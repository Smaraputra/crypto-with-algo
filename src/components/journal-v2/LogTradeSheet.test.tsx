import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { toast } from 'sonner';
import { LogTradeSheet } from './LogTradeSheet';
import * as journalHooks from '@/hooks/useJournal';
import * as disciplineHooks from '@/hooks/useDiscipline';
import * as signalsHooks from '@/hooks/useSignals';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { createJournalEntrySchema } from '@/types/journal';
import { useUIStore } from '@/stores/uiStore';

vi.mock('@/hooks/useJournal', () => ({
  useCreateJournalEntry: vi.fn(),
}));

vi.mock('@/hooks/useDiscipline', () => ({
  useDiscipline: vi.fn(),
}));

vi.mock('@/hooks/useSignals', () => ({
  useLatestSignalForStyle: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = MockResizeObserver;
window.HTMLElement.prototype.scrollIntoView = vi.fn();

describe('LogTradeSheet', () => {
  const onOpenChange = vi.fn();
  const mockMutateAsync = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ selectedSymbol: 'BTCUSDT' });

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

    vi.mocked(signalsHooks.useLatestSignalForStyle).mockImplementation(
      (symbol, style, interval) => {
        return {
          data: {
            signal: {
              _id: 'sig-1',
              symbol: symbol ?? 'BTCUSDT',
              interval: interval ?? '1h',
              tradingStyle: style ?? 'day_trading',
              score: 31.2,
              tier: 'buy',
              confidence: 80,
              components: [],
              configVersion: 1,
              candleTimestamp: 1700000000000,
              expiresAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
          },
          isLoading: false,
          isError: false,
        } as unknown as ReturnType<typeof signalsHooks.useLatestSignalForStyle>;
      }
    );
  });

  it('shows discipline nudges under "Before you log"', () => {
    render(<LogTradeSheet open={true} onOpenChange={onOpenChange} />);

    expect(screen.getByText('Before you log')).toBeInTheDocument();
    expect(
      screen.getByText('3 consecutive losses. Consider stepping away before the next trade.')
    ).toBeInTheDocument();
  });

  it('with a mocked signal (score: 31.2, tier: buy) for BTCUSDT at 1h, saving sends interval: 1h, signalScore: 31.2 and signalTier: buy', async () => {
    mockMutateAsync.mockResolvedValueOnce({ success: true });

    render(<LogTradeSheet open={true} onOpenChange={onOpenChange} initialSymbol="BTCUSDT" />);

    expect(
      screen.getByText('Price score now: Long score, 31.2.')
    ).toBeInTheDocument();

    const saveButton = screen.getByRole('button', { name: 'Save trade' });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTCUSDT',
        interval: '1h',
        signalScore: 31.2,
        signalTier: 'buy',
      })
    );

    expect(toast.success).toHaveBeenCalledWith('Trade saved');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('changing the interval to 4h queries swing_trading and 4h', () => {
    render(<LogTradeSheet open={true} onOpenChange={onOpenChange} initialSymbol="BTCUSDT" />);

    expect(signalsHooks.useLatestSignalForStyle).toHaveBeenCalledWith(
      'BTCUSDT',
      'day_trading',
      '1h'
    );

    const radio4h = screen.getByRole('radio', { name: '4h' });
    fireEvent.click(radio4h);

    expect(signalsHooks.useLatestSignalForStyle).toHaveBeenCalledWith(
      'BTCUSDT',
      'swing_trading',
      '4h'
    );
  });

  it('with no signal, Save is disabled and the inline message shows; mutation is not called', () => {
    vi.mocked(signalsHooks.useLatestSignalForStyle).mockReturnValue({
      data: { signal: null },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof signalsHooks.useLatestSignalForStyle>);

    render(<LogTradeSheet open={true} onOpenChange={onOpenChange} initialSymbol="BTCUSDT" />);

    const saveButton = screen.getByRole('button', { name: 'Save trade' });
    expect(saveButton).toBeDisabled();

    expect(
      screen.getByText(
        'No price score is available for this coin and interval yet, so the trade cannot be linked to one. Choose another interval or try again shortly.'
      )
    ).toBeInTheDocument();

    fireEvent.click(saveButton);
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('disables save while loading the price score', () => {
    vi.mocked(signalsHooks.useLatestSignalForStyle).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof signalsHooks.useLatestSignalForStyle>);

    render(<LogTradeSheet open={true} onOpenChange={onOpenChange} initialSymbol="BTCUSDT" />);

    const saveButton = screen.getByRole('button', { name: 'Save trade' });
    expect(saveButton).toBeDisabled();
    expect(screen.getByText('Loading the price score.')).toBeInTheDocument();
  });

  it('the payload keys are a subset of the schemas keys: assert against Object.keys(createJournalEntrySchema.shape)', async () => {
    mockMutateAsync.mockResolvedValueOnce({ success: true });

    render(<LogTradeSheet open={true} onOpenChange={onOpenChange} initialSymbol="BTCUSDT" />);

    fireEvent.change(screen.getByLabelText('Entry price'), { target: { value: '65000' } });
    fireEvent.change(screen.getByLabelText('Planned risk to reward'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('radio', { name: '4' })); // Conviction level 4
    fireEvent.change(screen.getByLabelText('Setup'), { target: { value: 'Breakout' } });
    fireEvent.change(screen.getByLabelText('Market condition'), { target: { value: 'trending_up' } });
    fireEvent.change(screen.getByLabelText('Emotion before'), { target: { value: 'confident' } });
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'breakout, momentum' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Clean 4h close' } });

    const saveButton = screen.getByRole('button', { name: 'Save trade' });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });

    const payload = mockMutateAsync.mock.calls[0][0] as Record<string, unknown>;
    const payloadKeys = Object.keys(payload);
    const schemaKeys = Object.keys(createJournalEntrySchema.shape);

    for (const key of payloadKeys) {
      expect(schemaKeys).toContain(key);
    }

    expect(payload).toEqual(
      expect.objectContaining({
        symbol: 'BTCUSDT',
        interval: '1h',
        signalScore: 31.2,
        signalTier: 'buy',
        action: 'buy',
        entryPrice: 65000,
        plannedRiskReward: 2.5,
        convictionLevel: 4,
        setupType: 'Breakout',
        marketCondition: 'trending_up',
        emotion: 'confident',
        tags: ['breakout', 'momentum'],
        notes: 'Clean 4h close',
      })
    );
  });

  it('there are no inputs labelled Quantity, Session, Your planned stop or Your planned target', () => {
    render(<LogTradeSheet open={true} onOpenChange={onOpenChange} />);

    expect(screen.queryByLabelText(/quantity/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/session/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/your planned stop/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/your planned target/i)).not.toBeInTheDocument();
  });

  it('the coin list offers only the ten signal coins', () => {
    render(<LogTradeSheet open={true} onOpenChange={onOpenChange} />);

    // Muted notice line under coin field
    expect(
      screen.getByText(
        'Trades are linked to the price score at the time you log them, which covers these ten coins.'
      )
    ).toBeInTheDocument();

    const trigger = screen.getByRole('combobox', { name: 'Coin' });
    fireEvent.click(trigger);

    const coinOptions = screen
      .getAllByRole('option')
      .filter((opt) => opt.getAttribute('data-slot') === 'command-item');
    expect(coinOptions).toHaveLength(SIGNAL_SYMBOLS.length);
    expect(SIGNAL_SYMBOLS).toHaveLength(10);

    const optionTexts = coinOptions.map((o) => o.textContent?.trim());
    const expectedBaseAssets = SIGNAL_SYMBOLS.map((s) => s.replace(/(USDT|USDC|BUSD)$/, ''));

    expect(optionTexts).toEqual(expectedBaseAssets);
  });

  it('validates entry price and planned risk to reward', async () => {
    render(<LogTradeSheet open={true} onOpenChange={onOpenChange} />);

    fireEvent.change(screen.getByLabelText('Entry price'), { target: { value: '-5' } });
    fireEvent.change(screen.getByLabelText('Planned risk to reward'), { target: { value: '0' } });

    const saveButton = screen.getByRole('button', { name: 'Save trade' });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByText('Entry price must be greater than 0.')).toBeInTheDocument();
      expect(
        screen.getByText('Planned risk to reward must be greater than 0 and at most 100.')
      ).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Planned risk to reward'), { target: { value: '150' } });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(
        screen.getByText('Planned risk to reward must be greater than 0 and at most 100.')
      ).toBeInTheDocument();
    });

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('defaults to useUIStore.selectedSymbol when it is one of SIGNAL_SYMBOLS, else BTCUSDT', () => {
    useUIStore.setState({ selectedSymbol: 'SOLUSDT' });
    const { unmount } = render(<LogTradeSheet open={true} onOpenChange={onOpenChange} />);
    expect(screen.getByRole('combobox', { name: 'Coin' })).toHaveTextContent('SOL');
    unmount();

    useUIStore.setState({ selectedSymbol: 'SOME_NON_SIGNAL_COIN' });
    render(<LogTradeSheet open={true} onOpenChange={onOpenChange} />);
    expect(screen.getByRole('combobox', { name: 'Coin' })).toHaveTextContent('BTC');
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
