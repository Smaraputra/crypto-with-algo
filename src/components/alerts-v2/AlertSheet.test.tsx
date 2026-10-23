import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertSheet } from './AlertSheet';
import { useCreateAlert } from '@/hooks/useAlerts';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { usePortfolio, usePortfolios } from '@/hooks/usePortfolio';
import { useTickers } from '@/hooks/usePrices';
import { useSymbols } from '@/hooks/useSymbols';

vi.mock('@/hooks/useAlerts', () => ({
  useCreateAlert: vi.fn(),
}));

vi.mock('@/hooks/useSymbols', () => ({
  useSymbols: vi.fn(),
}));

vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolios: vi.fn(),
  usePortfolio: vi.fn(),
}));

vi.mock('@/hooks/useBinanceStream', () => ({
  useBinanceTicker: vi.fn(),
}));

vi.mock('@/hooks/usePrices', () => ({
  useTickers: vi.fn(),
}));

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

vi.stubGlobal('ResizeObserver', MockResizeObserver);

const ALLOWED_SCHEMA_KEYS = [
  'symbol',
  'portfolioId',
  'type',
  'targetPrice',
  'percentChange',
  'referencePrice',
  'recurring',
  'cooldownMinutes',
  'message',
];

describe('AlertSheet', () => {
  const mockMutateAsync = vi.fn();
  const onOpenChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();

    vi.mocked(useCreateAlert).mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateAlert>);

    vi.mocked(useSymbols).mockReturnValue({
      data: [
        { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
        { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' },
      ],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSymbols>);

    vi.mocked(usePortfolios).mockReturnValue({
      data: {
        portfolios: [
          {
            _id: 'port-1',
            name: 'Primary Portfolio',
            holdingsCount: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePortfolios>);

    vi.mocked(usePortfolio).mockReturnValue({
      data: {
        portfolio: {
          _id: 'port-1',
          userId: 'user-1',
          name: 'Primary Portfolio',
          holdings: [
            {
              symbol: 'ETHUSDT',
              baseAsset: 'ETH',
              quoteAsset: 'USDT',
              quantity: 2,
              avgBuyPrice: 3000,
              transactions: [],
            },
          ],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePortfolio>);

    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {
        BTCUSDT: {
          symbol: 'BTCUSDT',
          lastPrice: '85000',
          priceChange: '500',
          priceChangePercent: '0.6',
          highPrice: '86000',
          lowPrice: '84000',
          volume: '100',
          quoteVolume: '8500000',
          openPrice: '84500',
        },
      },
      status: 'connected',
    } as unknown as ReturnType<typeof useBinanceTicker>);

    vi.mocked(useTickers).mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useTickers>);
  });

  it('validates inline when required fields are missing or invalid', async () => {
    const user = userEvent.setup();
    render(<AlertSheet open={true} onOpenChange={onOpenChange} />);

    const submitBtn = screen.getByRole('button', { name: 'Create alert' });
    await user.click(submitBtn);

    expect(screen.getByText('Please select a coin.')).toBeInTheDocument();
    expect(screen.getByText('Target price is required.')).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();

    // Select a coin
    await user.click(screen.getByRole('combobox', { name: 'Coin' }));
    await user.click(screen.getByRole('option', { name: 'BTC' }));

    // Type 0 for target price
    const valueInput = screen.getByLabelText('Target price');
    await user.type(valueInput, '0');
    await user.click(submitBtn);

    expect(screen.getByText('Value must be greater than 0.')).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('validates percent change bounds inline', async () => {
    const user = userEvent.setup();
    render(
      <AlertSheet
        open={true}
        onOpenChange={onOpenChange}
        initialSymbol="BTCUSDT"
      />
    );

    const typeSelect = screen.getByLabelText('Alert type');
    await user.selectOptions(typeSelect, 'price_change_pct');

    const valueInput = screen.getByLabelText('Percent change');
    await user.type(valueInput, '0');

    const submitBtn = screen.getByRole('button', { name: 'Create alert' });
    await user.click(submitBtn);

    expect(screen.getByText('Percent change cannot be 0.')).toBeInTheDocument();

    await user.clear(valueInput);
    await user.type(valueInput, '1500');
    await user.click(submitBtn);

    expect(
      screen.getByText('Percent change must be between -100% and 1000%.')
    ).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('validates portfolio requirement for portfolio alert types', async () => {
    const user = userEvent.setup();
    render(<AlertSheet open={true} onOpenChange={onOpenChange} />);

    const typeSelect = screen.getByLabelText('Alert type');
    await user.selectOptions(typeSelect, 'portfolio_value_above');

    const valueInput = screen.getByLabelText('Target portfolio value');
    await user.type(valueInput, '50000');

    const submitBtn = screen.getByRole('button', { name: 'Create alert' });
    await user.click(submitBtn);

    expect(screen.getByText('Please select a portfolio.')).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('creates a price_above alert with only schema-allowed payload keys', async () => {
    const user = userEvent.setup();
    mockMutateAsync.mockResolvedValueOnce({ alert: {} });

    render(<AlertSheet open={true} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('combobox', { name: 'Coin' }));
    await user.click(screen.getByRole('option', { name: 'BTC' }));

    const valueInput = screen.getByLabelText('Target price');
    await user.type(valueInput, '90000');

    const recurringCheckbox = screen.getByLabelText('Recurring alert');
    await user.click(recurringCheckbox);

    const noteInput = screen.getByLabelText('Note (optional)');
    await user.type(noteInput, 'Take profit level');

    const submitBtn = screen.getByRole('button', { name: 'Create alert' });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });

    const payload = mockMutateAsync.mock.calls[0][0];

    // Assert every key sent is in the create schema
    Object.keys(payload).forEach((k) => {
      expect(ALLOWED_SCHEMA_KEYS).toContain(k);
    });

    expect(payload).toEqual({
      type: 'price_above',
      symbol: 'BTCUSDT',
      targetPrice: 90000,
      recurring: true,
      cooldownMinutes: 60,
      message: 'Take profit level',
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('creates a price_change_pct alert sending referencePrice equal to mocked live price with only schema-allowed payload keys', async () => {
    const user = userEvent.setup();
    mockMutateAsync.mockResolvedValueOnce({ alert: {} });

    render(
      <AlertSheet
        open={true}
        onOpenChange={onOpenChange}
        initialSymbol="BTCUSDT"
      />
    );

    const typeSelect = screen.getByLabelText('Alert type');
    await user.selectOptions(typeSelect, 'price_change_pct');

    expect(
      screen.getByText('Measured from the current price, $85,000.')
    ).toBeInTheDocument();

    const valueInput = screen.getByLabelText('Percent change');
    await user.type(valueInput, '-5');

    const submitBtn = screen.getByRole('button', { name: 'Create alert' });
    expect(submitBtn).toBeEnabled();
    await user.click(submitBtn);

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });

    const payload = mockMutateAsync.mock.calls[0][0];

    Object.keys(payload).forEach((k) => {
      expect(ALLOWED_SCHEMA_KEYS).toContain(k);
    });

    expect(payload.type).toBe('price_change_pct');
    expect(payload.symbol).toBe('BTCUSDT');
    expect(payload.percentChange).toBe(-5);
    expect(payload.referencePrice).toBe(85000);
  });

  it('disables Create and shows waiting text when no live price is available for price_change_pct', async () => {
    const user = userEvent.setup();
    vi.mocked(useBinanceTicker).mockReturnValue({
      tickers: {},
      status: 'connected',
    } as unknown as ReturnType<typeof useBinanceTicker>);

    render(
      <AlertSheet
        open={true}
        onOpenChange={onOpenChange}
        initialSymbol="BTCUSDT"
      />
    );

    const typeSelect = screen.getByLabelText('Alert type');
    await user.selectOptions(typeSelect, 'price_change_pct');

    expect(
      screen.getByText(
        'Waiting for the current price, which this alert measures from.'
      )
    ).toBeInTheDocument();

    const submitBtn = screen.getByRole('button', { name: 'Create alert' });
    expect(submitBtn).toBeDisabled();
  });

  it('requires a portfolio and a coin held in it for holding_change_pct and shows measured from average cost', async () => {
    const user = userEvent.setup();
    render(<AlertSheet open={true} onOpenChange={onOpenChange} />);

    const typeSelect = screen.getByLabelText('Alert type');
    await user.selectOptions(typeSelect, 'holding_change_pct');

    const submitBtn = screen.getByRole('button', { name: 'Create alert' });
    await user.click(submitBtn);

    expect(screen.getByText('Please select a portfolio.')).toBeInTheDocument();
    expect(screen.getByText('Please select a coin.')).toBeInTheDocument();

    const portfolioSelect = screen.getByLabelText('Portfolio');
    await user.selectOptions(portfolioSelect, 'port-1');

    const prefillSelect = await screen.findByLabelText(
      'Prefill from portfolio holding (optional)'
    );
    await user.selectOptions(prefillSelect, 'ETHUSDT');

    expect(
      screen.getByText('Measured from your average cost, $3,000')
    ).toBeInTheDocument();
  });

  it('prefills coin from portfolio holdings dropdown', async () => {
    const user = userEvent.setup();
    render(<AlertSheet open={true} onOpenChange={onOpenChange} />);

    const portfolioSelect = screen.getByLabelText('Portfolio (optional)');
    await user.selectOptions(portfolioSelect, 'port-1');

    const prefillSelect = await screen.findByLabelText(
      'Prefill from portfolio holding (optional)'
    );
    await user.selectOptions(prefillSelect, 'ETHUSDT');

    expect(screen.getByRole('combobox', { name: 'Coin' })).toHaveTextContent(
      'ETH'
    );
  });
});
