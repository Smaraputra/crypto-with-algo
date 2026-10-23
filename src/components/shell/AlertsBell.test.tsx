import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertsBell } from './AlertsBell';

const mockUseAlerts = vi.fn();
const mockUseUnreadAlertCount = vi.fn();
const mockMutate = vi.fn();
const mockRefetch = vi.fn();

vi.mock('@/hooks/useAlerts', () => ({
  useAlerts: () => mockUseAlerts(),
  useUnreadAlertCount: () => mockUseUnreadAlertCount(),
  useAcknowledgeAlert: () => ({
    mutate: mockMutate,
  }),
}));

describe('AlertsBell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides badge when count is 0', () => {
    mockUseUnreadAlertCount.mockReturnValue(0);
    mockUseAlerts.mockReturnValue({
      data: { alerts: [] },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    });

    render(<AlertsBell />);
    expect(screen.queryByTestId('alerts-badge')).not.toBeInTheDocument();
  });

  it('shows badge with count when count is greater than 0', () => {
    mockUseUnreadAlertCount.mockReturnValue(3);
    mockUseAlerts.mockReturnValue({
      data: { alerts: [] },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    });

    render(<AlertsBell />);
    const badge = screen.getByTestId('alerts-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('3');
  });

  it('shows loading text when loading', () => {
    mockUseUnreadAlertCount.mockReturnValue(0);
    mockUseAlerts.mockReturnValue({
      data: null,
      isLoading: true,
      isError: false,
      refetch: mockRefetch,
    });

    render(<AlertsBell />);
    const trigger = screen.getByRole('button', { name: /alerts/i });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);

    expect(screen.getByText('Loading alerts.')).toBeInTheDocument();
  });

  it('shows error text and Try again button when error', () => {
    mockUseUnreadAlertCount.mockReturnValue(0);
    mockUseAlerts.mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
      refetch: mockRefetch,
    });

    render(<AlertsBell />);
    const trigger = screen.getByRole('button', { name: /alerts/i });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);

    expect(screen.getByText('Alerts did not load.')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: 'Try again' });
    fireEvent.click(retryBtn);
    expect(mockRefetch).toHaveBeenCalled();
  });

  it('shows empty text when no alerts', () => {
    mockUseUnreadAlertCount.mockReturnValue(0);
    mockUseAlerts.mockReturnValue({
      data: { alerts: [] },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    });

    render(<AlertsBell />);
    const trigger = screen.getByRole('button', { name: /alerts/i });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);

    expect(screen.getByText('No triggered alerts.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All alerts' })).toHaveAttribute('href', '/alerts');
  });

  it('lists triggered alerts and clicking Acknowledge calls mutation', () => {
    mockUseUnreadAlertCount.mockReturnValue(1);
    const mockAlert = {
      _id: 'alert-123',
      symbol: 'BTCUSDT',
      type: 'price_above',
      targetPrice: 70000,
      message: 'BTC above 70000',
      triggeredAt: new Date('2026-10-23T10:00:00Z'),
      notifiedAt: null,
    };

    mockUseAlerts.mockReturnValue({
      data: { alerts: [mockAlert] },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    });

    render(<AlertsBell />);
    const trigger = screen.getByRole('button', { name: /alerts/i });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);

    expect(screen.getByText('BTCUSDT')).toBeInTheDocument();
    expect(screen.getByText('BTC above 70000')).toBeInTheDocument();

    const ackBtn = screen.getByRole('button', { name: 'Acknowledge' });
    expect(ackBtn).toHaveClass('min-h-[44px]');
    fireEvent.click(ackBtn);

    expect(mockMutate).toHaveBeenCalledWith('alert-123');
  });
});
