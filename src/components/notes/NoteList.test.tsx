import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NoteList } from './NoteList';
import type { ResearchNote } from '@/types/research-note';

vi.mock('@/hooks/useResearchNotes', () => ({
  useResearchNotes: vi.fn().mockReturnValue({
    data: { notes: [] },
    isLoading: false,
    isError: false,
  }),
}));

const mockNotes: ResearchNote[] = [
  {
    _id: 'note-1',
    userId: 'user-1',
    title: 'Breakout System',
    content: 'First line of breakout system body\nSecond line',
    category: 'strategy',
    tags: ['btc'],
    relatedSymbols: ['BTCUSDT'],
    isPinned: false,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-22T14:30:00.000Z',
  },
  {
    _id: 'note-2',
    userId: 'user-1',
    title: 'Position Sizing Rule',
    content: 'Never risk more than 1%\nAlways calculate before entry',
    category: 'rule',
    tags: ['risk'],
    relatedSymbols: [],
    isPinned: true,
    createdAt: '2026-10-18T08:00:00.000Z',
    updatedAt: '2026-10-19T09:00:00.000Z',
  },
];

describe('NoteList', () => {
  const onSelectNote = vi.fn();
  const onNewNote = vi.fn();

  it('renders rows with title, category, updated time and the first line of the body', () => {
    render(
      <NoteList
        notes={mockNotes}
        onSelectNote={onSelectNote}
        onNewNote={onNewNote}
      />
    );

    // Row 1
    expect(screen.getByText('Breakout System')).toBeInTheDocument();
    expect(screen.getByText('strategy')).toBeInTheDocument();
    expect(screen.getByText('First line of breakout system body')).toBeInTheDocument();
    expect(screen.getByText(/Updated Oct 22, 2026/)).toBeInTheDocument();

    // Row 2
    expect(screen.getByText('Position Sizing Rule')).toBeInTheDocument();
    expect(screen.getByText('rule')).toBeInTheDocument();
    expect(screen.getByText('Never risk more than 1%')).toBeInTheDocument();
  });

  it('calls onSelectNote when a row is clicked or activated with keyboard', () => {
    render(
      <NoteList
        notes={mockNotes}
        onSelectNote={onSelectNote}
        onNewNote={onNewNote}
      />
    );

    const row1 = screen.getByRole('button', { name: 'Open note: Breakout System' });
    fireEvent.click(row1);
    expect(onSelectNote).toHaveBeenCalledWith(mockNotes[0]);

    const row2 = screen.getByRole('button', { name: 'Open note: Position Sizing Rule' });
    fireEvent.keyDown(row2, { key: 'Enter' });
    expect(onSelectNote).toHaveBeenCalledWith(mockNotes[1]);
  });

  it('indicates selected state when selectedId matches', () => {
    render(
      <NoteList
        notes={mockNotes}
        selectedId="note-1"
        onSelectNote={onSelectNote}
      />
    );

    const row1 = screen.getByRole('button', { name: 'Open note: Breakout System' });
    expect(row1).toHaveAttribute('aria-pressed', 'true');

    const row2 = screen.getByRole('button', { name: 'Open note: Position Sizing Rule' });
    expect(row2).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders loading state', () => {
    render(
      <NoteList
        isLoading={true}
        onSelectNote={onSelectNote}
      />
    );

    expect(screen.getByText('Loading notes...')).toBeInTheDocument();
  });

  it('renders error state', () => {
    render(
      <NoteList
        isError={true}
        onSelectNote={onSelectNote}
      />
    );

    expect(screen.getByText('Failed to load notes.')).toBeInTheDocument();
  });

  it('renders empty state: "No notes yet. Write your first note."', () => {
    render(
      <NoteList
        notes={[]}
        onSelectNote={onSelectNote}
        onNewNote={onNewNote}
      />
    );

    expect(screen.getByText('No notes yet. Write your first note.')).toBeInTheDocument();

    const newNoteBtn = screen.getByRole('button', { name: 'New note' });
    fireEvent.click(newNoteBtn);
    expect(onNewNote).toHaveBeenCalledTimes(1);
  });
});
