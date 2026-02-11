import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useResearchNotes', () => ({
  useResearchNotes: vi.fn(),
  useUpdateResearchNote: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useDeleteResearchNote: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useCreateResearchNote: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
);

import { PlaybookView } from './PlaybookView';
import { useResearchNotes } from '@/hooks/useResearchNotes';
import type { ResearchNote } from '@/types/research-note';

const mockNote: ResearchNote = {
  _id: 'rn-1',
  userId: 'user-1',
  title: 'Test strategy',
  content: '## Test content',
  category: 'strategy',
  tags: ['test'],
  relatedSymbols: ['BTCUSDT'],
  isPinned: false,
  createdAt: '2025-01-10T00:00:00.000Z',
  updatedAt: '2025-01-10T00:00:00.000Z',
};

describe('PlaybookView', () => {
  it('shows loading state', () => {
    vi.mocked(useResearchNotes).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useResearchNotes>);

    render(<PlaybookView />);
    expect(screen.getByTestId('playbook-loading')).toBeInTheDocument();
  });

  it('shows empty state when no notes', () => {
    vi.mocked(useResearchNotes).mockReturnValue({
      data: { notes: [], total: 0, page: 1, totalPages: 0 },
      isLoading: false,
    } as unknown as ReturnType<typeof useResearchNotes>);

    render(<PlaybookView />);
    expect(screen.getByTestId('playbook-empty')).toBeInTheDocument();
  });

  it('renders note list', () => {
    vi.mocked(useResearchNotes).mockReturnValue({
      data: { notes: [mockNote], total: 1, page: 1, totalPages: 1 },
      isLoading: false,
    } as unknown as ReturnType<typeof useResearchNotes>);

    render(<PlaybookView />);
    expect(screen.getByTestId('playbook-note-list')).toBeInTheDocument();
    expect(screen.getByText('Test strategy')).toBeInTheDocument();
  });

  it('shows no selection message by default', () => {
    vi.mocked(useResearchNotes).mockReturnValue({
      data: { notes: [mockNote], total: 1, page: 1, totalPages: 1 },
      isLoading: false,
    } as unknown as ReturnType<typeof useResearchNotes>);

    render(<PlaybookView />);
    expect(screen.getByTestId('playbook-no-selection')).toBeInTheDocument();
  });

  it('shows note detail when card is clicked', async () => {
    vi.mocked(useResearchNotes).mockReturnValue({
      data: { notes: [mockNote], total: 1, page: 1, totalPages: 1 },
      isLoading: false,
    } as unknown as ReturnType<typeof useResearchNotes>);

    render(<PlaybookView />);
    screen.getByTestId('research-note-card-rn-1').click();
    expect(await screen.findByTestId('playbook-detail')).toBeInTheDocument();
  });

  it('renders search input', () => {
    vi.mocked(useResearchNotes).mockReturnValue({
      data: { notes: [], total: 0, page: 1, totalPages: 0 },
      isLoading: false,
    } as unknown as ReturnType<typeof useResearchNotes>);

    render(<PlaybookView />);
    expect(screen.getByTestId('playbook-search')).toBeInTheDocument();
  });

  it('renders category filter buttons', () => {
    vi.mocked(useResearchNotes).mockReturnValue({
      data: { notes: [], total: 0, page: 1, totalPages: 0 },
      isLoading: false,
    } as unknown as ReturnType<typeof useResearchNotes>);

    render(<PlaybookView />);
    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Strategy')).toBeInTheDocument();
    expect(screen.getByText('Rule')).toBeInTheDocument();
  });

  it('renders new note button', () => {
    vi.mocked(useResearchNotes).mockReturnValue({
      data: { notes: [], total: 0, page: 1, totalPages: 0 },
      isLoading: false,
    } as unknown as ReturnType<typeof useResearchNotes>);

    render(<PlaybookView />);
    expect(screen.getByText('New Note')).toBeInTheDocument();
  });
});
