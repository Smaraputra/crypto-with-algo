import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NoteDetail } from './NoteDetail';
import * as noteHooks from '@/hooks/useResearchNotes';
import type { ResearchNote } from '@/types/research-note';

vi.mock('@/hooks/useResearchNotes', () => ({
  useDeleteResearchNote: vi.fn(),
}));

const mockNote: ResearchNote = {
  _id: 'note-1',
  userId: 'user-1',
  title: 'Test Note Title',
  content: 'Here is the markdown body with **bold** text and <script>alert("xss")</script>',
  category: 'strategy',
  tags: ['test'],
  relatedSymbols: ['BTCUSDT'],
  isPinned: false,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-21T12:00:00.000Z',
};

describe('NoteDetail', () => {
  const mockDeleteMutate = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(noteHooks.useDeleteResearchNote).mockReturnValue({
      mutateAsync: mockDeleteMutate,
      isPending: false,
    } as unknown as ReturnType<typeof noteHooks.useDeleteResearchNote>);
  });

  it('renders title, category and body', () => {
    render(<NoteDetail note={mockNote} onEdit={onEdit} onDelete={onDelete} />);

    expect(screen.getByRole('heading', { name: 'Test Note Title' })).toBeInTheDocument();
    expect(screen.getByText('strategy')).toBeInTheDocument();
    expect(screen.getByText(/bold/i)).toBeInTheDocument();
  });

  it('renders script tag literally as text instead of executing or omitting it', () => {
    render(<NoteDetail note={mockNote} onEdit={onEdit} onDelete={onDelete} />);

    const body = screen.getByTestId('note-body');
    expect(body.textContent).toContain('<script>alert("xss")</script>');
  });

  it('calls onEdit when edit button is clicked', () => {
    render(<NoteDetail note={mockNote} onEdit={onEdit} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('delete only happens after confirmation', async () => {
    render(<NoteDetail note={mockNote} onEdit={onEdit} onDelete={onDelete} />);

    // Click Delete button in header
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    // Delete mutation should not be called yet
    expect(mockDeleteMutate).not.toHaveBeenCalled();

    // Confirmation dialog appears
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Delete note')).toBeInTheDocument();
    expect(screen.getByText(/Are you sure you want to delete this note\?/i)).toBeInTheDocument();

    // Confirm delete in dialog
    const confirmButton = screen.getAllByRole('button', { name: 'Delete' }).find(
      (btn) => btn.closest('[role="dialog"]') !== null
    );
    expect(confirmButton).toBeDefined();
    fireEvent.click(confirmButton!);

    await waitFor(() => {
      expect(mockDeleteMutate).toHaveBeenCalledWith('note-1');
      expect(onDelete).toHaveBeenCalledWith('note-1');
    });
  });
});
