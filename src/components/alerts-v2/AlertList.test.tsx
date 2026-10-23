import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AlertList,
  formatAlertCondition,
  formatCurrency,
  formatDate,
  getBaseAsset,
} from './AlertList';
import * as alertsHooks from '@/hooks/useAlerts';
import * as binanceHooks from '@/hooks/useBinanceStream';
import * as pricesHooks from '@/hooks/usePrices';
import { ALERT_TYPES, type Alert } from '@/types/alert';

vi.mock('@/hooks/useAlerts', () => ({
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

const mockAlerts: Alert[] = [
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
  {
    _id: 'alert-2',
    userId: 'user-1',
    symbol: 'ETHUSDT',
    portfolioId: null,
    type: 'price_change_pct',
    targetPrice: null,
    percentChange: -5,
    referencePrice: 3500,
    status: 'triggered',
    recurring: true,
    cooldownMinutes: 60,
    message: '',
    triggeredAt: new Date('2026-10-21T12:00:00Z'),
    notifiedAt: null,
    lastTriggeredAt: new Date('2026-10-21T12:00:00Z'),
    createdAt: new Date('2026-10-20T10:00:00Z'),
    updatedAt: new Date('2026-10-21T12:00:00Z'),
  },
  {
    _id: 'alert-3',
    userId: 'user-1',
    symbol: 'SOLUSDT',
    portfolioId: null,
    type: 'price_below',
    targetPrice: 150,
    percentChange: null,
    referencePrice: null,
    status: 'paused',
    recurring: false,
    cooldownMinutes: 60,
    message: '',
    triggeredAt: null,
    notifiedAt: null,
    lastTriggeredAt: null,
    createdAt: new Date('2026-10-20T10:00:00Z'),
    updatedAt: new Date('2026-10-20T10:00:00Z'),
  },
];

describe('AlertList', () => {
  const mockAcknowledgeMutate = vi.fn();
  const mockUpdateMutate = vi.fn();
  const mockDeleteMutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(alertsHooks.useAcknowledgeAlert).mockReturnValue({
      mutate: mockAcknowledgeMutate,
      isPending: false,
    } as unknown as ReturnType<typeof alertsHooks.useAcknowledgeAlert>);

    vi.mocked(alertsHooks.useUpdateAlert).mockReturnValue({
      mutate: mockUpdateMutate,
      isPending: false,
    } as unknown as ReturnType<typeof alertsHooks.useUpdateAlert>);

    vi.mocked(alertsHooks.useDeleteAlert).mockReturnValue({
      mutate: mockDeleteMutate,
      isPending: false,
    } as unknown as ReturnType<typeof alertsHooks.useDeleteAlert>);

    vi.mocked(binanceHooks.useBinanceTicker).mockReturnValue({
      tickers: {
        BTCUSDT: {
          symbol: 'BTCUSDT',
          lastPrice: '85420.50',
          priceChange: '100',
          priceChangePercent: '1.2',
          highPrice: '86000',
          lowPrice: '84000',
          volume: '1000',
          quoteVolume: '85000000',
          openPrice: '85000',
        },
      },
      status: 'connected',
    } as unknown as ReturnType<typeof binanceHooks.useBinanceTicker>);

    vi.mocked(pricesHooks.useTickers).mockReturnValue({
      data: [
        {
          symbol: 'ETHUSDT',
          lastPrice: '3450.00',
          priceChange: '-50',
          priceChangePercent: '-1.4',
          highPrice: '3500',
          lowPrice: '3400',
          volume: '500',
          quoteVolume: '1700000',
          openPrice: '3500',
        },
      ],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof pricesHooks.useTickers>);
  });

  describe('condition formatting', () => {
    it('renders every ALERT_TYPES value as plain language with no raw key appearing', () => {
      const allTypeAlerts: Alert[] = [
        {
          ...mockAlerts[0],
          type: 'price_above',
          targetPrice: 85000,
        },
        {
          ...mockAlerts[0],
          type: 'price_below',
          targetPrice: 60000,
        },
        {
          ...mockAlerts[0],
          type: 'price_change_pct',
          percentChange: -5,
        },
        {
          ...mockAlerts[0],
          type: 'portfolio_value_above',
          targetPrice: 100000,
        },
        {
          ...mockAlerts[0],
          type: 'portfolio_value_below',
          targetPrice: 40000,
        },
        {
          ...mockAlerts[0],
          type: 'holding_change_pct',
          percentChange: 10,
        },
      ];

      ALERT_TYPES.forEach((type, index) => {
        const alert = allTypeAlerts[index];
        const text = formatAlertCondition(alert);

        expect(text).not.toContain(type);
        expect(text.length).toBeGreaterThan(0);
      });

      expect(
        formatAlertCondition({
          type: 'price_above',
          targetPrice: 85000,
          percentChange: null,
        })
      ).toBe('Price above $85,000');

      expect(
        formatAlertCondition({
          type: 'price_change_pct',
          targetPrice: null,
          percentChange: -5,
        })
      ).toBe('Drops 5% in 24 hours');

      expect(
        formatAlertCondition({
          type: 'price_change_pct',
          targetPrice: null,
          percentChange: 10,
        })
      ).toBe('Price moves 10% in 24 hours');

      expect(
        formatAlertCondition({
          type: 'portfolio_value_above',
          targetPrice: 50000,
          percentChange: null,
        })
      ).toBe('Portfolio value above $50,000');

      expect(
        formatAlertCondition({
          type: 'portfolio_value_below',
          targetPrice: 20000,
          percentChange: null,
        })
      ).toBe('Portfolio value below $20,000');

      expect(
        formatAlertCondition({
          type: 'holding_change_pct',
          targetPrice: null,
          percentChange: -10,
        })
      ).toBe('Holding drops 10%');
    });

    it('handles missing values with n/a and no raw key', () => {
      expect(
        formatAlertCondition({
          type: 'price_above',
          targetPrice: null,
          percentChange: null,
        })
      ).toBe('Price above n/a');

      expect(
        formatAlertCondition({
          type: 'price_change_pct',
          targetPrice: null,
          percentChange: null,
        })
      ).toBe('Price change n/a');
    });
  });

  describe('rendering and layout', () => {
    it('renders empty state when there are no alerts', () => {
      render(<AlertList alerts={[]} />);
      expect(screen.getByText('No alerts yet.')).toBeInTheDocument();
      expect(
        screen.getByText('Create one to be told when a price moves.')
      ).toBeInTheDocument();
    });

    it('renders loading state', () => {
      render(<AlertList isLoading={true} />);
      expect(screen.getByText('Loading alerts')).toBeInTheDocument();
    });

    it('renders error state with Try again action', () => {
      const onRefetch = vi.fn();
      render(<AlertList isError={true} onRefetch={onRefetch} />);
      expect(screen.getByText('Alerts did not load.')).toBeInTheDocument();

      const retryBtn = screen.getByRole('button', { name: 'Try again' });
      fireEvent.click(retryBtn);
      expect(onRefetch).toHaveBeenCalledTimes(1);
    });

    it('renders alert rows with coin links, current prices and statuses', () => {
      render(<AlertList alerts={mockAlerts} />);

      const btcLinks = screen.getAllByRole('link', { name: 'BTC' });
      expect(btcLinks.length).toBeGreaterThan(0);
      expect(btcLinks[0]).toHaveAttribute('href', '/focus?symbol=BTCUSDT');

      expect(screen.getAllByText('Price above $85,000').length).toBeGreaterThan(
        0
      );
      expect(
        screen.getAllByText('Drops 5% in 24 hours').length
      ).toBeGreaterThan(0);

      expect(screen.getAllByText('$85,420.50').length).toBeGreaterThan(0);
      expect(screen.getAllByText('$3,450').length).toBeGreaterThan(0);

      expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Triggered').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Paused').length).toBeGreaterThan(0);
    });
  });

  describe('row actions', () => {
    it('calls acknowledge mutation when Acknowledge is clicked for triggered alert', () => {
      render(<AlertList alerts={mockAlerts} />);

      const ackButtons = screen.getAllByRole('button', {
        name: 'Acknowledge',
      });
      expect(ackButtons.length).toBeGreaterThan(0);

      fireEvent.click(ackButtons[0]);
      expect(mockAcknowledgeMutate).toHaveBeenCalledWith('alert-2');
    });

    it('calls pause mutation when Pause is clicked for active alert', () => {
      render(<AlertList alerts={mockAlerts} />);

      const pauseButtons = screen.getAllByRole('button', { name: 'Pause' });
      expect(pauseButtons.length).toBeGreaterThan(0);

      fireEvent.click(pauseButtons[0]);
      expect(mockUpdateMutate).toHaveBeenCalledWith({
        id: 'alert-1',
        status: 'paused',
      });
    });

    it('calls resume mutation when Resume is clicked for paused alert', () => {
      render(<AlertList alerts={mockAlerts} />);

      const resumeButtons = screen.getAllByRole('button', { name: 'Resume' });
      expect(resumeButtons.length).toBeGreaterThan(0);

      fireEvent.click(resumeButtons[0]);
      expect(mockUpdateMutate).toHaveBeenCalledWith({
        id: 'alert-3',
        status: 'active',
      });
    });

    it('requires confirmation before calling delete mutation', async () => {
      const user = userEvent.setup();
      render(<AlertList alerts={mockAlerts} />);

      const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
      await user.click(deleteButtons[0]);

      expect(screen.getByText('Delete alert')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Are you sure you want to delete this alert? This action cannot be undone.'
        )
      ).toBeInTheDocument();
      expect(mockDeleteMutate).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(mockDeleteMutate).not.toHaveBeenCalled();

      await user.click(deleteButtons[0]);
      const confirmDelete = screen.getByRole('button', { name: 'Delete' });
      await user.click(confirmDelete);

      expect(mockDeleteMutate).toHaveBeenCalledWith('alert-1', expect.any(Object));
    });
  });

  describe('format helpers', () => {
    it('formats currency correctly', () => {
      expect(formatCurrency(85000)).toBe('$85,000');
      expect(formatCurrency(85000.5)).toBe('$85,000.50');
      expect(formatCurrency(null)).toBe('n/a');
      expect(formatCurrency(undefined)).toBe('n/a');
      expect(formatCurrency(NaN)).toBe('n/a');
    });

    it('formats date correctly', () => {
      expect(formatDate(null)).toBe('n/a');
      expect(formatDate(new Date('2026-10-20T10:00:00Z'))).toContain('2026');
    });

    it('extracts base asset correctly', () => {
      expect(getBaseAsset('BTCUSDT')).toBe('BTC');
      expect(getBaseAsset('ETHUSDC')).toBe('ETH');
      expect(getBaseAsset(null)).toBe('n/a');
      expect(getBaseAsset('')).toBe('n/a');
    });
  });
});
