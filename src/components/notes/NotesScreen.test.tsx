import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NotesScreen } from './NotesScreen';
import * as noteHooks from '@/hooks/useResearchNotes';
import type { ResearchNote } from '@/types/research-note';

vi.mock('@/hooks/useResearchNotes', () => ({
  useResearchNotes: vi.fn(),
  useCreateResearchNote: vi.fn().mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useUpdateResearchNote: vi.fn().mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useDeleteResearchNote: vi.fn().mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const mockNotes: ResearchNote[] = [
  {
    _id: 'rn-1',
    userId: 'user-1',
    title: 'BTC breakout strategy',
    content: 'First line of BTC breakout strategy\nSecond line here',
    category: 'strategy',
    tags: ['breakout', 'btc'],
    relatedSymbols: ['BTCUSDT'],
    isPinned: true,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  },
  {
    _id: 'rn-2',
    userId: 'user-1',
    title: 'Risk management rules',
    content: 'Never risk more than 2% per trade',
    category: 'rule',
    tags: ['risk'],
    relatedSymbols: [],
    isPinned: false,
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
  },
];

describe('NotesScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(noteHooks.useResearchNotes).mockReturnValue({
      data: {
        notes: mockNotes,
        total: 2,
        page: 1,
        totalPages: 1,
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof noteHooks.useResearchNotes>);
  });

  it('renders PageHeader titled "Notes", the green "New note" button and the switcher with Notes current', () => {
    render(<NotesScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'Notes' })).toBeInTheDocument();

    const newNoteButtons = screen.getAllByRole('button', { name: 'New note' });
    expect(newNoteButtons[0]).toHaveClass('bg-brand');

    expect(screen.getByRole('link', { name: 'Trades' })).toHaveAttribute('href', '/journal');
    expect(screen.getByRole('link', { name: 'Stats' })).toHaveAttribute('href', '/journal?view=stats');
    expect(screen.getByText('Notes', { selector: 'span[aria-current="page"]' })).toBeInTheDocument();
  });

  it('search and category call useResearchNotes with the right filters', async () => {
    const { rerender } = render(<NotesScreen />);

    // Initially called with empty filters
    expect(noteHooks.useResearchNotes).toHaveBeenCalledWith({});

    // Type in search field
    const searchInput = screen.getByLabelText('Search notes');
    fireEvent.change(searchInput, { target: { value: 'breakout' } });

    rerender(<NotesScreen />);

    expect(noteHooks.useResearchNotes).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'breakout' })
    );

    // Select Category option for "strategy"
    const categorySelect = screen.getByLabelText('Category');
    fireEvent.change(categorySelect, { target: { value: 'strategy' } });

    rerender(<NotesScreen />);

    expect(noteHooks.useResearchNotes).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'breakout', category: 'strategy' })
    );
  });

  it('selecting a row shows the detail in the right column', () => {
    render(<NotesScreen />);

    // Row 1 click
    const row = screen.getByRole('button', { name: 'Open note: BTC breakout strategy' });
    fireEvent.click(row);

    // NoteDetail is rendered
    expect(screen.getByTestId('note-detail')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'BTC breakout strategy' })
    ).toBeInTheDocument();
  });

  it('clicking New note opens the NoteEditor in the right column', () => {
    render(<NotesScreen />);

    const newNoteButton = screen.getAllByRole('button', { name: 'New note' })[0];
    fireEvent.click(newNoteButton);

    expect(screen.getByTestId('note-editor')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'New note' })).toBeInTheDocument();
  });

  it('renders loading state when notes are loading', () => {
    vi.mocked(noteHooks.useResearchNotes).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof noteHooks.useResearchNotes>);

    render(<NotesScreen />);
    expect(screen.getByText('Loading notes...')).toBeInTheDocument();
  });

  it('renders error state when notes fail to load', () => {
    vi.mocked(noteHooks.useResearchNotes).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof noteHooks.useResearchNotes>);

    render(<NotesScreen />);
    expect(screen.getByText('Failed to load notes.')).toBeInTheDocument();
  });

  it('renders empty state when there are no notes', () => {
    vi.mocked(noteHooks.useResearchNotes).mockReturnValue({
      data: { notes: [], total: 0, page: 1, totalPages: 0 },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof noteHooks.useResearchNotes>);

    render(<NotesScreen />);
    expect(screen.getByText('No notes yet. Write your first note.')).toBeInTheDocument();
  });
});
