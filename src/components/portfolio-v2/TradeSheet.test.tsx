import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TradeSheet } from './TradeSheet';
import { useSymbols } from '@/hooks/useSymbols';
import { useAddHolding, useRecordTransaction } from '@/hooks/usePortfolio';
import { toast } from 'sonner';

vi.mock('@/hooks/useSymbols', () => ({
  useSymbols: vi.fn(),
}));

vi.mock('@/hooks/usePortfolio', () => ({
  useAddHolding: vi.fn(),
  useRecordTransaction: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

vi.stubGlobal('ResizeObserver', MockResizeObserver);

describe('TradeSheet', () => {
  const mutateAddHoldingAsync = vi.fn();
  const mutateRecordTxAsync = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();

    vi.mocked(useSymbols).mockReturnValue({
      data: [
        { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
        { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' },
        { symbol: 'BNBUSDT', baseAsset: 'BNB', quoteAsset: 'USDT' },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useSymbols>);

    vi.mocked(useAddHolding).mockReturnValue({
      mutateAsync: mutateAddHoldingAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useAddHolding>);

    vi.mocked(useRecordTransaction).mockReturnValue({
      mutateAsync: mutateRecordTxAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useRecordTransaction>);
  });

  it('validates required fields inline in add mode', async () => {
    const user = userEvent.setup();
    render(
      <TradeSheet
        open={true}
        onOpenChange={vi.fn()}
        portfolioId="port-1"
        mode="add"
      />
    );

    const submitBtn = screen.getByRole('button', { name: 'Save trade' });
    await user.click(submitBtn);

    expect(screen.getByText('Please select a coin.')).toBeInTheDocument();
    expect(screen.getByText('Quantity must be greater than 0.')).toBeInTheDocument();
    expect(screen.getByText('Price must be greater than 0.')).toBeInTheDocument();
    expect(mutateAddHoldingAsync).not.toHaveBeenCalled();
  });

  it('validates future date inline', async () => {
    const user = userEvent.setup();
    render(
      <TradeSheet
        open={true}
        onOpenChange={vi.fn()}
        portfolioId="port-1"
        mode="add"
      />
    );

    await user.click(screen.getByRole('combobox', { name: 'Coin' }));
    await user.type(screen.getByPlaceholderText('Search coin...'), 'BNB');
    await user.click(screen.getByRole('option', { name: 'BNB' }));
    await user.type(screen.getByLabelText('Quantity'), '1.5');
    await user.type(screen.getByLabelText('Buy price'), '60000');

    const dateInput = screen.getByLabelText('Date');
    await user.clear(dateInput);
    await user.type(dateInput, '2099-12-31');

    await user.click(screen.getByRole('button', { name: 'Save trade' }));

    expect(screen.getByText('Date cannot be in the future.')).toBeInTheDocument();
    expect(mutateAddHoldingAsync).not.toHaveBeenCalled();
  });

  it('blocks a sell above the holding in record mode', async () => {
    const user = userEvent.setup();
    const mockHolding = {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      quantity: 1.5,
      avgBuyPrice: 50000,
      transactions: [],
    };

    render(
      <TradeSheet
        open={true}
        onOpenChange={vi.fn()}
        portfolioId="port-1"
        mode="record"
        initialHolding={mockHolding}
      />
    );

    // Switch to Sell
    const sellRadio = screen.getByRole('radio', { name: 'Sell' });
    await user.click(sellRadio);

    // Try to sell 2.0 (holding is 1.5)
    await user.type(screen.getByLabelText('Quantity'), '2.0');
    await user.type(screen.getByLabelText('Price'), '60000');

    await user.click(screen.getByRole('button', { name: 'Save trade' }));

    expect(
      screen.getByText('Sell quantity cannot exceed held quantity.')
    ).toBeInTheDocument();
    expect(mutateRecordTxAsync).not.toHaveBeenCalled();
  });

  it('calls add holding mutation with right payload and fires toast on success', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mutateAddHoldingAsync.mockResolvedValueOnce({});

    render(
      <TradeSheet
        open={true}
        onOpenChange={onOpenChange}
        portfolioId="port-1"
        mode="add"
      />
    );

    await user.click(screen.getByRole('combobox', { name: 'Coin' }));
    await user.type(screen.getByPlaceholderText('Search coin...'), 'BNB');
    await user.click(screen.getByRole('option', { name: 'BNB' }));
    await user.type(screen.getByLabelText('Quantity'), '2');
    await user.type(screen.getByLabelText('Buy price'), '55000');
    await user.type(screen.getByLabelText('Fee'), '10');
    await user.type(screen.getByLabelText('Note'), 'Initial buy');

    await user.click(screen.getByRole('button', { name: 'Save trade' }));

    await waitFor(() => {
      expect(mutateAddHoldingAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          symbol: 'BNBUSDT',
          baseAsset: 'BNB',
          quoteAsset: 'USDT',
          type: 'buy',
          quantity: 2,
          price: 55000,
          fee: 10,
          notes: 'Initial buy',
        })
      );
    });

    expect(toast.success).toHaveBeenCalledWith('Trade saved');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('calls record transaction mutation with right payload in record mode', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mutateRecordTxAsync.mockResolvedValueOnce({});

    const mockHolding = {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      quantity: 5,
      avgBuyPrice: 50000,
      transactions: [],
    };

    render(
      <TradeSheet
        open={true}
        onOpenChange={onOpenChange}
        portfolioId="port-1"
        mode="record"
        initialHolding={mockHolding}
      />
    );

    const sellRadio = screen.getByRole('radio', { name: 'Sell' });
    await user.click(sellRadio);

    await user.type(screen.getByLabelText('Quantity'), '1');
    const priceInput = screen.getByLabelText('Price');
    await user.clear(priceInput);
    await user.type(priceInput, '65000');

    await user.click(screen.getByRole('button', { name: 'Save trade' }));

    await waitFor(() => {
      expect(mutateRecordTxAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'sell',
          quantity: 1,
          price: 65000,
        })
      );
    });

    expect(toast.success).toHaveBeenCalledWith('Trade saved');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('displays server error inline in the sheet on rejection', async () => {
    const user = userEvent.setup();
    mutateAddHoldingAsync.mockRejectedValueOnce(new Error('Symbol already exists in portfolio'));

    render(
      <TradeSheet
        open={true}
        onOpenChange={vi.fn()}
        portfolioId="port-1"
        mode="add"
      />
    );

    await user.click(screen.getByRole('combobox', { name: 'Coin' }));
    await user.type(screen.getByPlaceholderText('Search coin...'), 'BNB');
    await user.click(screen.getByRole('option', { name: 'BNB' }));
    await user.type(screen.getByLabelText('Quantity'), '1');
    await user.type(screen.getByLabelText('Buy price'), '50000');

    await user.click(screen.getByRole('button', { name: 'Save trade' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Symbol already exists in portfolio'
      );
    });
  });

  it('combobox supports typing to filter base asset and Escape to close', async () => {
    const user = userEvent.setup();
    render(
      <TradeSheet
        open={true}
        onOpenChange={vi.fn()}
        portfolioId="port-1"
        mode="add"
      />
    );

    const combobox = screen.getByRole('combobox', { name: 'Coin' });
    expect(combobox).toHaveTextContent('Select coin');

    await user.click(combobox);
    expect(screen.getByPlaceholderText('Search coin...')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search coin...'), 'ETH');
    expect(screen.getByRole('option', { name: 'ETH' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Search coin...')).not.toBeInTheDocument();
    });
  });
});
