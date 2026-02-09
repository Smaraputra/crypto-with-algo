import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { JournalEntryCard } from './JournalEntryCard';
import { mockJournalEntry, mockJournalEntry2, mockSkippedEntry } from '@/__fixtures__/journal';

describe('JournalEntryCard', () => {
  it('renders entry symbol and action', () => {
    render(
      <JournalEntryCard entry={mockJournalEntry} onDelete={vi.fn()} isDeleting={false} />
    );
    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByText('BUY')).toBeInTheDocument();
  });

  it('shows signal score', () => {
    render(
      <JournalEntryCard entry={mockJournalEntry} onDelete={vi.fn()} isDeleting={false} />
    );
    expect(screen.getByText('45')).toBeInTheDocument();
  });

  it('shows entry price when present', () => {
    render(
      <JournalEntryCard entry={mockJournalEntry} onDelete={vi.fn()} isDeleting={false} />
    );
    expect(screen.getByText(/Entry:/)).toBeInTheDocument();
  });

  it('shows PnL when outcome is set', () => {
    render(
      <JournalEntryCard entry={mockJournalEntry2} onDelete={vi.fn()} isDeleting={false} />
    );
    expect(screen.getByText('+4.55%')).toBeInTheDocument();
  });

  it('shows notes when present', () => {
    render(
      <JournalEntryCard entry={mockJournalEntry} onDelete={vi.fn()} isDeleting={false} />
    );
    expect(screen.getByText('Strong momentum signal')).toBeInTheDocument();
  });

  it('calls onDelete when delete button clicked', () => {
    const onDelete = vi.fn();
    render(
      <JournalEntryCard entry={mockJournalEntry} onDelete={onDelete} isDeleting={false} />
    );
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledWith('journal-1');
  });

  it('disables delete button when deleting', () => {
    render(
      <JournalEntryCard entry={mockJournalEntry} onDelete={vi.fn()} isDeleting={true} />
    );
    expect(screen.getByRole('button', { name: /delete/i })).toBeDisabled();
  });

  it('renders skip action styling', () => {
    render(
      <JournalEntryCard entry={mockSkippedEntry} onDelete={vi.fn()} isDeleting={false} />
    );
    expect(screen.getByText('SKIP')).toBeInTheDocument();
  });
});
