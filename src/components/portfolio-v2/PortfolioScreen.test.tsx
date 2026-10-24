import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PortfolioScreen } from './PortfolioScreen';
import {
  usePortfolios,
  usePortfolio,
  useCreatePortfolio,
  useRenamePortfolio,
  useDeletePortfolio,
} from '@/hooks/usePortfolio';
import { useRouter, useSearchParams } from 'next/navigation';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  usePathname: vi.fn(() => '/portfolio'),
  useSearchParams: vi.fn(),
}));

vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolios: vi.fn(),
  usePortfolio: vi.fn(),
  useCreatePortfolio: vi.fn(),
  useRenamePortfolio: vi.fn(),
  useDeletePortfolio: vi.fn(),
  useRemoveHolding: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useAddHolding: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useRecordTransaction: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

vi.mock('@/hooks/useBinanceStream', () => ({
  useBinanceTicker: vi.fn(() => ({ tickers: {} })),
}));

vi.mock('@/hooks/usePrices', () => ({
  useTickers: vi.fn(() => ({ data: [] })),
}));

vi.mock('@/hooks/useAnalytics', () => ({
  usePortfolioHistory: vi.fn(() => ({ data: { history: [] } })),
  useCostBasis: vi.fn(() => ({ data: { costBasis: { holdings: [] } } })),
  useRiskMetrics: vi.fn(() => ({ data: { metrics: null, insufficientData: true } })),
  useExportCsv: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

vi.mock('@/hooks/useSymbols', () => ({
  useSymbols: vi.fn(() => ({ data: [] })),
}));

describe('PortfolioScreen', () => {
  const mockPush = vi.fn();
  const mockCreateMutateAsync = vi.fn();
  const mockRenameMutateAsync = vi.fn();
  const mockDeleteMutateAsync = vi.fn();

  const mockPortfolios = [
    { _id: 'port-1', name: 'Main Portfolio', holdingsCount: 2, createdAt: new Date(), updatedAt: new Date() },
    { _id: 'port-2', name: 'DeFi Portfolio', holdingsCount: 0, createdAt: new Date(), updatedAt: new Date() },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useRouter).mockReturnValue({
      push: mockPush,
    } as unknown as ReturnType<typeof useRouter>);

    vi.mocked(useSearchParams).mockReturnValue({
      get: vi.fn((key) => (key === 'tab' ? null : null)),
      toString: () => '',
    } as unknown as ReturnType<typeof useSearchParams>);

    vi.mocked(usePortfolios).mockReturnValue({
      data: { portfolios: mockPortfolios },
      isLoading: false,
    } as unknown as ReturnType<typeof usePortfolios>);

    vi.mocked(usePortfolio).mockReturnValue({
      data: {
        portfolio: {
          _id: 'port-1',
          userId: 'user-1',
          name: 'Main Portfolio',
          holdings: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      isLoading: false,
    } as unknown as ReturnType<typeof usePortfolio>);

    vi.mocked(useCreatePortfolio).mockReturnValue({
      mutateAsync: mockCreateMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCreatePortfolio>);

    vi.mocked(useRenamePortfolio).mockReturnValue({
      mutateAsync: mockRenameMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useRenamePortfolio>);

    vi.mocked(useDeletePortfolio).mockReturnValue({
      mutateAsync: mockDeleteMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useDeletePortfolio>);
  });

  it('renders empty state when no portfolios exist', () => {
    vi.mocked(usePortfolios).mockReturnValue({
      data: { portfolios: [] },
      isLoading: false,
    } as unknown as ReturnType<typeof usePortfolios>);

    render(<PortfolioScreen />);

    expect(
      screen.getByText('Create your first portfolio to track holdings.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New portfolio' })).toBeInTheDocument();
  });

  it('renders portfolio picker and switches tab following ?tab=performance', () => {
    // When ?tab=performance
    vi.mocked(useSearchParams).mockReturnValue({
      get: vi.fn((key) => (key === 'tab' ? 'performance' : null)),
      toString: () => 'tab=performance',
    } as unknown as ReturnType<typeof useSearchParams>);

    render(<PortfolioScreen />);

    // Page header title
    expect(screen.getByRole('heading', { level: 1, name: 'Portfolio' })).toBeInTheDocument();

    // Portfolio picker
    const picker = screen.getByLabelText('Portfolio');
    expect(picker).toBeInTheDocument();
    expect(picker).toHaveValue('port-1');
    const label = screen.getByText('Portfolio', { selector: 'label' });
    expect(label).toHaveClass('sr-only');

    // Performance tab is active
    const performanceRadio = screen.getByRole('radio', { name: 'Performance' });
    expect(performanceRadio).toBeChecked();

    // Performance panels appear
    expect(screen.getByRole('heading', { name: 'Value over time' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Cost basis' })).toBeInTheDocument();
  });

  it('navigates when segmented control changes tab', async () => {
    const user = userEvent.setup();
    render(<PortfolioScreen />);

    const performanceRadio = screen.getByRole('radio', { name: 'Performance' });
    await user.click(performanceRadio);

    expect(mockPush).toHaveBeenCalledWith('/portfolio?tab=performance');
  });

  it('supports rename flow with dialog confirmation', async () => {
    const user = userEvent.setup();
    mockRenameMutateAsync.mockResolvedValueOnce({});

    render(<PortfolioScreen />);

    // Open Manage dropdown
    const manageBtn = screen.getByRole('button', { name: 'Manage' });
    await user.click(manageBtn);

    // Click Rename
    const renameMenuItem = await screen.findByRole('menuitem', { name: 'Rename' });
    await user.click(renameMenuItem);

    // Dialog appears
    expect(screen.getByText('Change the name of your portfolio.')).toBeInTheDocument();
    const nameInput = screen.getByLabelText('Portfolio name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Updated Name');

    const submitRename = screen.getByRole('button', { name: 'Rename' });
    await user.click(submitRename);

    await waitFor(() => {
      expect(mockRenameMutateAsync).toHaveBeenCalledWith({
        id: 'port-1',
        name: 'Updated Name',
      });
    });
  });

  it('supports delete flow with dialog confirmation', async () => {
    const user = userEvent.setup();
    mockDeleteMutateAsync.mockResolvedValueOnce({});

    render(<PortfolioScreen />);

    const manageBtn = screen.getByRole('button', { name: 'Manage' });
    await user.click(manageBtn);

    const deleteMenuItem = await screen.findByRole('menuitem', { name: 'Delete' });
    await user.click(deleteMenuItem);

    // Delete dialog appears
    expect(
      screen.getByText(/Are you sure you want to delete "Main Portfolio"\?/)
    ).toBeInTheDocument();

    const deleteBtn = screen.getByRole('button', { name: 'Delete' });
    await user.click(deleteBtn);

    await waitFor(() => {
      expect(mockDeleteMutateAsync).toHaveBeenCalledWith('port-1');
    });
  });

  it('supports creating a new portfolio from manage menu', async () => {
    const user = userEvent.setup();
    mockCreateMutateAsync.mockResolvedValueOnce({});

    render(<PortfolioScreen />);

    const manageBtn = screen.getByRole('button', { name: 'Manage' });
    await user.click(manageBtn);

    const newMenuItem = await screen.findByRole('menuitem', { name: 'New portfolio' });
    await user.click(newMenuItem);

    const nameInput = screen.getByLabelText('Portfolio name');
    await user.type(nameInput, 'Staking Vault');

    const createBtn = screen.getByRole('button', { name: 'Create' });
    await user.click(createBtn);

    await waitFor(() => {
      expect(mockCreateMutateAsync).toHaveBeenCalledWith('Staking Vault');
    });
  });

  it('selects the portfolio it just created', async () => {
    const user = userEvent.setup();
    mockCreateMutateAsync.mockResolvedValueOnce({ portfolio: { _id: 'port-2', name: 'DeFi Portfolio' } });

    render(<PortfolioScreen />);
    expect(screen.getByLabelText('Portfolio')).toHaveValue('port-1');

    await user.click(screen.getByRole('button', { name: 'Manage' }));
    await user.click(await screen.findByRole('menuitem', { name: 'New portfolio' }));
    await user.type(screen.getByLabelText('Portfolio name'), 'DeFi Portfolio');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Portfolio')).toHaveValue('port-2');
    });
  });
});
