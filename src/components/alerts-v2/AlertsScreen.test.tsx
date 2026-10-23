import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertsScreen } from './AlertsScreen';
import * as alertsHooks from '@/hooks/useAlerts';
import * as binanceHooks from '@/hooks/useBinanceStream';
import * as pricesHooks from '@/hooks/usePrices';
import * as symbolsHooks from '@/hooks/useSymbols';
import * as portfolioHooks from '@/hooks/usePortfolio';

vi.mock('@/hooks/useAlerts', () => ({
  useAlerts: vi.fn(),
  useCreateAlert: vi.fn(),
  useAcknowledgeAlert: vi.fn(),
  useUpdateAlert: vi.fn(),
  useDeleteAlert: vi.fn(),
}));

vi.mock('@/hooks/useBinanceStream', () => ({
  useBinanceTicker: vi.fn(),
}));

vi.mock('@/hooks/usePrices', () => ({
  useTickers: vi.fn(),
}));

vi.mock('@/hooks/useSymbols', () => ({
  useSymbols: vi.fn(),
}));

vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolios: vi.fn(),
  usePortfolio: vi.fn(),
}));

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

vi.stubGlobal('ResizeObserver', MockResizeObserver);

describe('AlertsScreen', () => {
  const mockRefetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();

    vi.mocked(alertsHooks.useAlerts).mockReturnValue({
      data: {
        alerts: [
          {
            _id: 'alert-1',
            userId: 'user-1',
            symbol: 'BTCUSDT',
            portfolioId: null,
            type: 'price_above',
            targetPrice: 85000,
            percentChange: null,
            referencePrice: null,
            status: 'active',
            recurring: false,
            cooldownMinutes: 60,
            message: '',
            triggeredAt: null,
            notifiedAt: null,
            lastTriggeredAt: null,
            createdAt: new Date('2026-10-20T10:00:00Z'),
            updatedAt: new Date('2026-10-20T10:00:00Z'),
          },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    } as unknown as ReturnType<typeof alertsHooks.useAlerts>);

    vi.mocked(alertsHooks.useCreateAlert).mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof alertsHooks.useCreateAlert>);

    vi.mocked(alertsHooks.useAcknowledgeAlert).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof alertsHooks.useAcknowledgeAlert>);

    vi.mocked(alertsHooks.useUpdateAlert).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof alertsHooks.useUpdateAlert>);

    vi.mocked(alertsHooks.useDeleteAlert).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof alertsHooks.useDeleteAlert>);

    vi.mocked(binanceHooks.useBinanceTicker).mockReturnValue({
      tickers: {},
      status: 'connected',
    } as unknown as ReturnType<typeof binanceHooks.useBinanceTicker>);

    vi.mocked(pricesHooks.useTickers).mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof pricesHooks.useTickers>);

    vi.mocked(symbolsHooks.useSymbols).mockReturnValue({
      data: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof symbolsHooks.useSymbols>);

    vi.mocked(portfolioHooks.usePortfolios).mockReturnValue({
      data: { portfolios: [] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof portfolioHooks.usePortfolios>);

    vi.mocked(portfolioHooks.usePortfolio).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof portfolioHooks.usePortfolio>);
  });

  it('renders PageHeader titled Alerts and New alert button', () => {
    render(<AlertsScreen />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Alerts' })
    ).toBeInTheDocument();

    const newAlertBtn = screen.getByRole('button', { name: 'New alert' });
    expect(newAlertBtn).toBeInTheDocument();
    expect(newAlertBtn).toHaveClass('bg-brand');
  });

  it('queries useAlerts without status filter by default for All', () => {
    render(<AlertsScreen />);
    expect(alertsHooks.useAlerts).toHaveBeenCalledWith(undefined);
  });

  it('queries useAlerts with status when SegmentedControl selection changes', () => {
    render(<AlertsScreen />);

    const activeRadio = screen.getByRole('radio', { name: 'Active' });
    fireEvent.click(activeRadio);
    expect(alertsHooks.useAlerts).toHaveBeenCalledWith('active');

    const triggeredRadio = screen.getByRole('radio', { name: 'Triggered' });
    fireEvent.click(triggeredRadio);
    expect(alertsHooks.useAlerts).toHaveBeenCalledWith('triggered');

    const pausedRadio = screen.getByRole('radio', { name: 'Paused' });
    fireEvent.click(pausedRadio);
    expect(alertsHooks.useAlerts).toHaveBeenCalledWith('paused');

    const allRadio = screen.getByRole('radio', { name: 'All' });
    fireEvent.click(allRadio);
    expect(alertsHooks.useAlerts).toHaveBeenCalledWith(undefined);
  });

  it('opens AlertSheet when New alert button is clicked', async () => {
    const user = userEvent.setup();
    render(<AlertsScreen />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const newAlertBtn = screen.getByRole('button', { name: 'New alert' });
    await user.click(newAlertBtn);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'New alert' })
    ).toBeInTheDocument();
  });
});
