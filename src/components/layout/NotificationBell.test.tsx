import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationBell } from './NotificationBell';
import type { Alert } from '@/types/alert';

const mockAcknowledgeMutate = vi.fn();

function makeTriggeredAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    _id: 'a1',
    userId: 'user-1',
    symbol: 'BTCUSDT',
    portfolioId: null,
    type: 'price_above',
    targetPrice: 100000,
    percentChange: null,
    referencePrice: null,
    status: 'triggered',
    recurring: false,
    cooldownMinutes: 60,
    message: '',
    triggeredAt: new Date(),
    notifiedAt: null,
    lastTriggeredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

let mockUnreadCount = 0;
let mockAlerts: Alert[] = [];

vi.mock('@/hooks/useAlerts', () => ({
  useUnreadAlertCount: () => mockUnreadCount,
  useAlerts: () => ({
    data: { alerts: mockAlerts },
  }),
  useAcknowledgeAlert: () => ({ mutate: mockAcknowledgeMutate }),
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockUnreadCount = 0;
  mockAlerts = [];
});

describe('NotificationBell', () => {
  it('renders bell icon', () => {
    render(<NotificationBell />);

    expect(screen.getByLabelText('Notifications')).toBeInTheDocument();
  });

  it('hides badge when count is 0', () => {
    mockUnreadCount = 0;
    render(<NotificationBell />);

    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
  });

  it('shows badge with count when alerts exist', () => {
    mockUnreadCount = 3;
    render(<NotificationBell />);

    const badge = screen.getByTestId('notification-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('3');
  });

  it('shows 99+ for large counts', () => {
    mockUnreadCount = 150;
    render(<NotificationBell />);

    expect(screen.getByTestId('notification-badge')).toHaveTextContent('99+');
  });

  it('opens popover on click with empty state', async () => {
    const user = userEvent.setup();
    render(<NotificationBell />);

    await user.click(screen.getByLabelText('Notifications'));

    expect(screen.getByText('No new notifications')).toBeInTheDocument();
  });

  it('shows triggered alerts in popover', async () => {
    const user = userEvent.setup();
    mockUnreadCount = 1;
    mockAlerts = [makeTriggeredAlert()];

    render(<NotificationBell />);

    await user.click(screen.getByLabelText('Notifications'));

    expect(screen.getByText(/BTCUSDT above/)).toBeInTheDocument();
  });

  it('calls dismiss on alert dismiss button click', async () => {
    const user = userEvent.setup();
    mockUnreadCount = 1;
    mockAlerts = [makeTriggeredAlert()];

    render(<NotificationBell />);

    await user.click(screen.getByLabelText('Notifications'));
    await user.click(screen.getByLabelText('Dismiss'));

    expect(mockAcknowledgeMutate).toHaveBeenCalledWith('a1');
  });

  it('shows Mark All Read button when alerts exist', async () => {
    const user = userEvent.setup();
    mockUnreadCount = 2;
    mockAlerts = [
      makeTriggeredAlert({ _id: 'a1' }),
      makeTriggeredAlert({ _id: 'a2', symbol: 'ETHUSDT', targetPrice: 3000 }),
    ];

    render(<NotificationBell />);

    await user.click(screen.getByLabelText('Notifications'));

    expect(screen.getByText('Mark All Read')).toBeInTheDocument();
  });

  it('calls acknowledge for all alerts on Mark All Read', async () => {
    const user = userEvent.setup();
    mockUnreadCount = 2;
    mockAlerts = [
      makeTriggeredAlert({ _id: 'a1' }),
      makeTriggeredAlert({ _id: 'a2' }),
    ];

    render(<NotificationBell />);

    await user.click(screen.getByLabelText('Notifications'));
    await user.click(screen.getByText('Mark All Read'));

    expect(mockAcknowledgeMutate).toHaveBeenCalledWith('a1');
    expect(mockAcknowledgeMutate).toHaveBeenCalledWith('a2');
  });

  it('contains View All link to alerts page', async () => {
    const user = userEvent.setup();
    render(<NotificationBell />);

    await user.click(screen.getByLabelText('Notifications'));

    const link = screen.getByText('View All Alerts');
    expect(link).toHaveAttribute('href', '/alerts?status=triggered');
  });
});
