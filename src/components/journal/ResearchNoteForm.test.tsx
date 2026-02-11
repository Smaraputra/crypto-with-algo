import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useResearchNotes', () => ({
  useCreateResearchNote: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useUpdateResearchNote: vi.fn(() => ({
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

import { ResearchNoteForm } from './ResearchNoteForm';
import type { ResearchNote } from '@/types/research-note';

describe('ResearchNoteForm', () => {
  it('renders new note trigger button', () => {
    render(<ResearchNoteForm />);
    expect(screen.getByText('New Note')).toBeInTheDocument();
  });

  it('renders custom trigger', () => {
    render(
      <ResearchNoteForm
        trigger={<button data-testid="custom-trigger">Custom</button>}
      />
    );
    expect(screen.getByTestId('custom-trigger')).toBeInTheDocument();
  });

  it('opens dialog on trigger click', async () => {
    render(<ResearchNoteForm />);
    screen.getByText('New Note').click();
    expect(await screen.findByText('New Research Note')).toBeInTheDocument();
  });

  it('shows edit title when note is provided', async () => {
    const note: ResearchNote = {
      _id: 'rn-1',
      userId: 'user-1',
      title: 'Existing note',
      content: 'Content',
      category: 'strategy',
      tags: ['tag1'],
      relatedSymbols: ['BTCUSDT'],
      isPinned: false,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    render(<ResearchNoteForm note={note} />);
    screen.getByText('New Note').click();
    expect(await screen.findByText('Edit Note')).toBeInTheDocument();
  });

  it('shows category select in dialog', async () => {
    render(<ResearchNoteForm />);
    screen.getByText('New Note').click();
    expect(await screen.findByText('Category')).toBeInTheDocument();
  });

  it('shows content input in dialog', async () => {
    render(<ResearchNoteForm />);
    screen.getByText('New Note').click();
    expect(await screen.findByTestId('note-content-input')).toBeInTheDocument();
  });

  it('has disabled submit button without title and category', async () => {
    render(<ResearchNoteForm />);
    screen.getByText('New Note').click();
    const submit = await screen.findByText('Create Note');
    expect(submit).toBeDisabled();
  });
});
