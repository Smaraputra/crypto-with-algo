import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useAlerts', () => ({
  useAlerts: () => ({
    data: { alerts: [] },
    isLoading: false,
  }),
  useCreateAlert: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateAlert: () => ({ mutate: vi.fn() }),
  useDeleteAlert: () => ({ mutate: vi.fn() }),
  useAcknowledgeAlert: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolios: () => ({ data: { portfolios: [] } }),
  usePortfolio: () => ({ data: undefined }),
}));

import AlertsPage from './page';

describe('AlertsPage', () => {
  it('renders heading and create button', () => {
    render(<AlertsPage />);

    expect(screen.getByText('Alerts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create alert/i })).toBeInTheDocument();
  });

  it('renders filter tabs', () => {
    render(<AlertsPage />);

    expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Active' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Triggered' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Paused' })).toBeInTheDocument();
  });

  it('renders empty alert list', () => {
    render(<AlertsPage />);

    expect(screen.getByTestId('alert-list-empty')).toBeInTheDocument();
  });
});
