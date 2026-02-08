import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AlertList } from './AlertList';
import type { Alert } from '@/types/alert';

const mockUpdateMutate = vi.fn();
const mockDeleteMutate = vi.fn();
const mockAcknowledgeMutate = vi.fn();

vi.mock('@/hooks/useAlerts', () => ({
  useUpdateAlert: () => ({ mutate: mockUpdateMutate }),
  useDeleteAlert: () => ({ mutate: mockDeleteMutate }),
  useAcknowledgeAlert: () => ({ mutate: mockAcknowledgeMutate }),
}));

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    _id: 'a1',
    userId: 'user-1',
    symbol: 'BTCUSDT',
    portfolioId: null,
    type: 'price_above',
    targetPrice: 100000,
    percentChange: null,
    referencePrice: null,
    status: 'active',
    recurring: false,
    cooldownMinutes: 60,
    message: '',
    triggeredAt: null,
    notifiedAt: null,
    lastTriggeredAt: null,
    createdAt: new Date('2024-01-15'),
    updatedAt: new Date('2024-01-15'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AlertList', () => {
  it('shows loading skeletons when loading', () => {
    render(<AlertList alerts={[]} isLoading={true} />);

    expect(screen.getByTestId('alert-list-loading')).toBeInTheDocument();
  });

  it('shows empty state when no alerts', () => {
    render(<AlertList alerts={[]} isLoading={false} />);

    expect(screen.getByTestId('alert-list-empty')).toBeInTheDocument();
    expect(screen.getByText('No alerts yet')).toBeInTheDocument();
  });

  it('renders alert items with correct description', () => {
    const alerts = [
      makeAlert({ _id: 'a1', type: 'price_above', symbol: 'BTCUSDT', targetPrice: 100000 }),
      makeAlert({ _id: 'a2', type: 'price_below', symbol: 'ETHUSDT', targetPrice: 2000 }),
    ];

    render(<AlertList alerts={alerts} isLoading={false} />);

    expect(screen.getByText(/BTCUSDT price above/)).toBeInTheDocument();
    expect(screen.getByText(/ETHUSDT price below/)).toBeInTheDocument();
  });

  it('shows status badges', () => {
    const alerts = [
      makeAlert({ _id: 'a1', status: 'active' }),
      makeAlert({ _id: 'a2', status: 'triggered' }),
      makeAlert({ _id: 'a3', status: 'paused' }),
    ];

    render(<AlertList alerts={alerts} isLoading={false} />);

    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('triggered')).toBeInTheDocument();
    expect(screen.getByText('paused')).toBeInTheDocument();
  });

  it('shows recurring badge for recurring alerts', () => {
    const alerts = [makeAlert({ recurring: true })];

    render(<AlertList alerts={alerts} isLoading={false} />);

    expect(screen.getByText('recurring')).toBeInTheDocument();
  });

  it('shows acknowledge button for triggered unread alerts', () => {
    const alerts = [
      makeAlert({ status: 'triggered', triggeredAt: new Date(), notifiedAt: null }),
    ];

    render(<AlertList alerts={alerts} isLoading={false} />);

    expect(screen.getByTitle('Acknowledge')).toBeInTheDocument();
  });

  it('calls acknowledge mutation on click', async () => {
    const user = userEvent.setup();
    const alerts = [
      makeAlert({ status: 'triggered', triggeredAt: new Date(), notifiedAt: null }),
    ];

    render(<AlertList alerts={alerts} isLoading={false} />);

    await user.click(screen.getByTitle('Acknowledge'));

    expect(mockAcknowledgeMutate).toHaveBeenCalledWith('a1');
  });

  it('shows pause button for active alerts', () => {
    const alerts = [makeAlert({ status: 'active' })];

    render(<AlertList alerts={alerts} isLoading={false} />);

    expect(screen.getByTitle('Pause')).toBeInTheDocument();
  });

  it('calls update mutation to pause on click', async () => {
    const user = userEvent.setup();
    const alerts = [makeAlert({ status: 'active' })];

    render(<AlertList alerts={alerts} isLoading={false} />);

    await user.click(screen.getByTitle('Pause'));

    expect(mockUpdateMutate).toHaveBeenCalledWith({
      id: 'a1',
      status: 'paused',
    });
  });

  it('shows resume button for paused alerts', () => {
    const alerts = [makeAlert({ status: 'paused' })];

    render(<AlertList alerts={alerts} isLoading={false} />);

    expect(screen.getByTitle('Resume')).toBeInTheDocument();
  });

  it('shows delete confirmation dialog', async () => {
    const user = userEvent.setup();
    const alerts = [makeAlert()];

    render(<AlertList alerts={alerts} isLoading={false} />);

    await user.click(screen.getByTitle('Delete'));

    expect(screen.getByText('Delete Alert')).toBeInTheDocument();
    expect(screen.getByText(/Are you sure/)).toBeInTheDocument();
  });

  it('calls delete mutation after confirm', async () => {
    const user = userEvent.setup();
    const alerts = [makeAlert()];

    render(<AlertList alerts={alerts} isLoading={false} />);

    await user.click(screen.getByTitle('Delete'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(mockDeleteMutate).toHaveBeenCalledWith('a1');
  });

  it('renders alert message when present', () => {
    const alerts = [makeAlert({ message: 'Buy the dip' })];

    render(<AlertList alerts={alerts} isLoading={false} />);

    expect(screen.getByText('Buy the dip')).toBeInTheDocument();
  });

  it('renders all 6 alert types correctly', () => {
    const alerts = [
      makeAlert({ _id: 'a1', type: 'price_above', targetPrice: 100000 }),
      makeAlert({ _id: 'a2', type: 'price_below', targetPrice: 50000 }),
      makeAlert({ _id: 'a3', type: 'price_change_pct', percentChange: 5, symbol: 'ETHUSDT' }),
      makeAlert({ _id: 'a4', type: 'portfolio_value_above', targetPrice: 200000, portfolioId: 'p1' }),
      makeAlert({ _id: 'a5', type: 'portfolio_value_below', targetPrice: 10000, portfolioId: 'p1' }),
      makeAlert({ _id: 'a6', type: 'holding_change_pct', percentChange: -10, portfolioId: 'p1' }),
    ];

    render(<AlertList alerts={alerts} isLoading={false} />);

    expect(screen.getByText('Price Above')).toBeInTheDocument();
    expect(screen.getByText('Price Below')).toBeInTheDocument();
    expect(screen.getByText('Price % Change')).toBeInTheDocument();
    expect(screen.getByText('Portfolio Above')).toBeInTheDocument();
    expect(screen.getByText('Portfolio Below')).toBeInTheDocument();
    expect(screen.getByText('Holding % Change')).toBeInTheDocument();
  });
});
