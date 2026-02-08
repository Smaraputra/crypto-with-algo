import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PortfolioSelector } from './PortfolioSelector';

const mockPortfolios = {
  portfolios: [
    { _id: 'p1', name: 'My Portfolio', holdingsCount: 2, createdAt: new Date(), updatedAt: new Date() },
    { _id: 'p2', name: 'Trading', holdingsCount: 0, createdAt: new Date(), updatedAt: new Date() },
  ],
};

const mockUsePortfolios = vi.fn();
const mockCreateMutate = vi.fn();
const mockRenameMutate = vi.fn();
const mockDeleteMutate = vi.fn();

vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolios: () => mockUsePortfolios(),
  useCreatePortfolio: () => ({ mutate: mockCreateMutate }),
  useRenamePortfolio: () => ({ mutate: mockRenameMutate }),
  useDeletePortfolio: () => ({ mutate: mockDeleteMutate }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockUsePortfolios.mockReturnValue({ data: mockPortfolios, isLoading: false });
});

describe('PortfolioSelector', () => {
  it('renders selected portfolio name', () => {
    render(<PortfolioSelector selectedId="p1" onSelect={vi.fn()} />);

    expect(screen.getByTestId('portfolio-selector-trigger')).toHaveTextContent('My Portfolio');
  });

  it('shows loading skeleton when loading', () => {
    mockUsePortfolios.mockReturnValue({ data: null, isLoading: true });

    render(<PortfolioSelector selectedId={null} onSelect={vi.fn()} />);

    expect(screen.getByTestId('selector-skeleton')).toBeInTheDocument();
  });

  it('shows portfolio list in dropdown', async () => {
    const user = userEvent.setup();
    render(<PortfolioSelector selectedId="p1" onSelect={vi.fn()} />);

    await user.click(screen.getByTestId('portfolio-selector-trigger'));

    const items = screen.getAllByText('My Portfolio');
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Trading')).toBeInTheDocument();
  });

  it('shows holdings count for each portfolio', async () => {
    const user = userEvent.setup();
    render(<PortfolioSelector selectedId="p1" onSelect={vi.fn()} />);

    await user.click(screen.getByTestId('portfolio-selector-trigger'));

    expect(screen.getByText('2 holdings')).toBeInTheDocument();
    expect(screen.getByText('0 holdings')).toBeInTheDocument();
  });

  it('shows Create New Portfolio option', async () => {
    const user = userEvent.setup();
    render(<PortfolioSelector selectedId="p1" onSelect={vi.fn()} />);

    await user.click(screen.getByTestId('portfolio-selector-trigger'));

    expect(screen.getByText('Create New Portfolio')).toBeInTheDocument();
  });

  it('shows rename and delete buttons for each portfolio', async () => {
    const user = userEvent.setup();
    render(<PortfolioSelector selectedId="p1" onSelect={vi.fn()} />);

    await user.click(screen.getByTestId('portfolio-selector-trigger'));

    expect(screen.getByLabelText('Rename My Portfolio')).toBeInTheDocument();
    expect(screen.getByLabelText('Delete My Portfolio')).toBeInTheDocument();
  });

  it('shows confirmation dialog before deleting', async () => {
    const user = userEvent.setup();
    render(<PortfolioSelector selectedId="p1" onSelect={vi.fn()} />);

    await user.click(screen.getByTestId('portfolio-selector-trigger'));
    await user.click(screen.getByLabelText('Delete My Portfolio'));

    // Confirmation dialog should appear
    expect(screen.getByText('Delete portfolio?')).toBeInTheDocument();
    expect(screen.getByText(/permanently delete/)).toBeInTheDocument();

    // Delete should not have been called yet
    expect(mockDeleteMutate).not.toHaveBeenCalled();
  });
});
