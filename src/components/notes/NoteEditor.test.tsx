import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { toast } from 'sonner';
import { NoteEditor } from './NoteEditor';
import * as noteHooks from '@/hooks/useResearchNotes';
import {
  createResearchNoteSchema,
  updateResearchNoteSchema,
  type ResearchNote,
} from '@/types/research-note';

vi.mock('@/hooks/useResearchNotes', () => ({
  useCreateResearchNote: vi.fn(),
  useUpdateResearchNote: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const mockNote: ResearchNote = {
  _id: 'note-123',
  userId: 'user-1',
  title: 'Existing Strategy Note',
  content: 'Existing strategy content',
  category: 'strategy',
  tags: ['crypto'],
  relatedSymbols: ['BTCUSDT'],
  isPinned: false,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
};

describe('NoteEditor', () => {
  const mockCreateMutate = vi.fn();
  const mockUpdateMutate = vi.fn();
  const onSuccess = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(noteHooks.useCreateResearchNote).mockReturnValue({
      mutateAsync: mockCreateMutate,
      isPending: false,
    } as unknown as ReturnType<typeof noteHooks.useCreateResearchNote>);

    vi.mocked(noteHooks.useUpdateResearchNote).mockReturnValue({
      mutateAsync: mockUpdateMutate,
      isPending: false,
    } as unknown as ReturnType<typeof noteHooks.useUpdateResearchNote>);
  });

  it('renders fields with labels and inline validation for required title and category', async () => {
    render(<NoteEditor onCancel={onCancel} />);

    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toBeInTheDocument();
    expect(screen.getByLabelText('Body')).toBeInTheDocument();

    // Try submitting empty form
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    // Inline errors appear
    expect(await screen.findByText('Title is required')).toBeInTheDocument();
    expect(screen.getByText('Category is required')).toBeInTheDocument();
    expect(mockCreateMutate).not.toHaveBeenCalled();
  });

  it('creates note, sends right payload matching schema, and shows "Note saved"', async () => {
    mockCreateMutate.mockResolvedValueOnce({
      note: { ...mockNote, _id: 'new-note-1', title: 'Fresh Playbook Idea' },
    });

    render(<NoteEditor onSuccess={onSuccess} />);

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Fresh Playbook Idea' },
    });
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'concept' },
    });
    fireEvent.change(screen.getByLabelText('Body'), {
      target: { value: 'Details of the playbook concept' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    await waitFor(() => {
      expect(mockCreateMutate).toHaveBeenCalledTimes(1);
    });

    const payload = mockCreateMutate.mock.calls[0][0];

    // Assert payload keys against createResearchNoteSchema
    const parseResult = createResearchNoteSchema.safeParse(payload);
    expect(parseResult.success).toBe(true);

    // Verify exact expected keys sent
    expect(payload).toEqual({
      title: 'Fresh Playbook Idea',
      category: 'concept',
      content: 'Details of the playbook concept',
    });

    // Ensure no invented defaults were sent
    expect(payload).not.toHaveProperty('tags');
    expect(payload).not.toHaveProperty('relatedSymbols');
    expect(payload).not.toHaveProperty('isPinned');

    expect(toast.success).toHaveBeenCalledWith('Note saved');
    expect(onSuccess).toHaveBeenCalled();
  });

  it('edits note, sends right payload matching update schema, and shows "Note saved"', async () => {
    mockUpdateMutate.mockResolvedValueOnce({
      note: { ...mockNote, title: 'Updated Title' },
    });

    render(<NoteEditor note={mockNote} onSuccess={onSuccess} onCancel={onCancel} />);

    expect(screen.getByDisplayValue('Existing Strategy Note')).toBeInTheDocument();
    expect((screen.getByLabelText('Category') as HTMLSelectElement).value).toBe('strategy');
    expect(screen.getByDisplayValue('Existing strategy content')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Updated Title' },
    });
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'rule' },
    });
    fireEvent.change(screen.getByLabelText('Body'), {
      target: { value: 'Updated content' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    await waitFor(() => {
      expect(mockUpdateMutate).toHaveBeenCalledTimes(1);
    });

    const callArg = mockUpdateMutate.mock.calls[0][0];
    expect(callArg.id).toBe('note-123');

    const updatePayload = { ...callArg };
    delete (updatePayload as Record<string, unknown>).id;
    // Assert payload keys against updateResearchNoteSchema
    const parseResult = updateResearchNoteSchema.safeParse(updatePayload);
    expect(parseResult.success).toBe(true);

    expect(updatePayload).toEqual({
      title: 'Updated Title',
      category: 'rule',
      content: 'Updated content',
    });

    expect(toast.success).toHaveBeenCalledWith('Note saved');
    expect(onSuccess).toHaveBeenCalled();
  });

  it('invokes onCancel when cancel button is clicked', () => {
    render(<NoteEditor onCancel={onCancel} />);

    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButtons[0]);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
