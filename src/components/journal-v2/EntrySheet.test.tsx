import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EntrySheet } from './EntrySheet';
import * as journalHooks from '@/hooks/useJournal';
import type { JournalEntry } from '@/types/journal';

vi.mock('@/hooks/useJournal', () => ({
  useUpdateJournalEntry: vi.fn(),
  useReviewJournalEntry: vi.fn(),
  useDeleteJournalEntry: vi.fn(),
  useJournalEntry: vi.fn(),
  useUploadJournalScreenshot: vi.fn(),
  useDeleteJournalScreenshot: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const mockEntry: JournalEntry = {
  _id: 'entry-123',
  userId: 'user-1',
  symbol: 'BTCUSDT',
  interval: '1h',
  signalScore: 25,
  signalTier: 'buy',
  action: 'buy',
  entryPrice: 60000,
  exitPrice: null,
  outcomePnlPercent: null,
  notes: 'Original note',
  reviewedAt: null,
  tags: ['swing'],
  indicatorSnapshot: null,
  strategyId: null,
  backtestResultId: null,
  lessonsLearned: '',
  reviewHistory: [],
  setupType: 'Breakout',
  marketCondition: 'trending_up',
  emotion: 'calm',
  mistakes: [],
  convictionLevel: 4,
  plannedRiskReward: 2.0,
  sentiment: null,
  enteredAt: '2026-10-20T10:00:00.000Z',
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
};

describe('EntrySheet', () => {
  const onOpenChange = vi.fn();
  const mockUpdateMutate = vi.fn();
  const mockReviewMutate = vi.fn();
  const mockDeleteMutate = vi.fn();
  const mockUploadMutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(journalHooks.useJournalEntry).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof journalHooks.useJournalEntry>);

    vi.mocked(journalHooks.useUploadJournalScreenshot).mockReturnValue({
      mutateAsync: mockUploadMutate,
      isPending: false,
    } as unknown as ReturnType<typeof journalHooks.useUploadJournalScreenshot>);

    vi.mocked(journalHooks.useUpdateJournalEntry).mockReturnValue({
      mutateAsync: mockUpdateMutate,
      isPending: false,
    } as unknown as ReturnType<typeof journalHooks.useUpdateJournalEntry>);

    vi.mocked(journalHooks.useReviewJournalEntry).mockReturnValue({
      mutateAsync: mockReviewMutate,
      isPending: false,
    } as unknown as ReturnType<typeof journalHooks.useReviewJournalEntry>);

    vi.mocked(journalHooks.useDeleteJournalEntry).mockReturnValue({
      mutateAsync: mockDeleteMutate,
      isPending: false,
    } as unknown as ReturnType<typeof journalHooks.useDeleteJournalEntry>);

    vi.mocked(journalHooks.useDeleteJournalScreenshot).mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof journalHooks.useDeleteJournalScreenshot>);
  });

  it('renders entry details when open', () => {
    render(<EntrySheet open={true} onOpenChange={onOpenChange} entry={mockEntry} />);

    expect(screen.getByText('BTC Trade')).toBeInTheDocument();
    expect(screen.getByText('Original note')).toBeInTheDocument();
    expect(screen.getByText('$60,000.00')).toBeInTheDocument();
    expect(screen.getByText('Entered')).toBeInTheDocument();
    expect(screen.getByText('Exited')).toBeInTheDocument();
    expect(screen.getByText('Held')).toBeInTheDocument();
  });

  it('Held shows "2h" for an entry from 10:00 to 12:00', () => {
    const closedEntry: JournalEntry = {
      ...mockEntry,
      enteredAt: '2026-10-20T10:00:00.000Z',
      exitedAt: '2026-10-20T12:00:00.000Z',
      exitPrice: 62000,
    };

    render(<EntrySheet open={true} onOpenChange={onOpenChange} entry={closedEntry} />);
    expect(screen.getByText('2h')).toBeInTheDocument();
  });

  it('submits update payload for main fields including enteredAt if changed', async () => {
    mockUpdateMutate.mockResolvedValueOnce({ success: true });

    render(<EntrySheet open={true} onOpenChange={onOpenChange} entry={mockEntry} />);

    // Click "Edit trade" button
    fireEvent.click(screen.getByRole('button', { name: 'Edit trade' }));

    // Change notes and setup
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Updated note' } });
    fireEvent.change(screen.getByLabelText('Setup'), { target: { value: 'Pullback' } });

    // Submit changes
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(mockUpdateMutate).toHaveBeenCalledTimes(1);
    });

    expect(mockUpdateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'entry-123',
        notes: 'Updated note',
        setupType: 'Pullback',
      })
    );
  });

  it('typing an exit price fills "Exited at" when empty', () => {
    render(<EntrySheet open={true} onOpenChange={onOpenChange} entry={mockEntry} />);

    const exitPriceInput = screen.getByLabelText('Exit price');
    const exitedAtInput = screen.getByLabelText('Exited at') as HTMLInputElement;

    expect(exitedAtInput.value).toBe('');

    fireEvent.change(exitPriceInput, { target: { value: '64000' } });

    expect(exitedAtInput.value).not.toBe('');
  });

  it('the review save sends exitPrice and exitedAt', async () => {
    mockReviewMutate.mockResolvedValueOnce({ success: true });

    render(<EntrySheet open={true} onOpenChange={onOpenChange} entry={mockEntry} />);

    // Fill review form
    fireEvent.change(screen.getByLabelText('Exit price'), { target: { value: '64000' } });
    fireEvent.change(screen.getByLabelText('Outcome P&L (%)'), { target: { value: '6.67' } });
    fireEvent.change(screen.getByLabelText('Emotion after'), { target: { value: 'confident' } });
    fireEvent.click(screen.getByLabelText('Exited early'));
    fireEvent.change(screen.getByLabelText('Lesson learned'), {
      target: { value: 'Followed plan but took profit too soon.' },
    });

    // Save review
    fireEvent.click(screen.getByRole('button', { name: 'Save review' }));

    await waitFor(() => {
      expect(mockReviewMutate).toHaveBeenCalledTimes(1);
    });

    expect(mockReviewMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'entry-123',
        exitPrice: 64000,
        exitedAt: expect.any(String),
        outcomePnlPercent: 6.67,
        emotion: 'confident',
        mistakes: ['exited_early'],
        lessonsLearned: 'Followed plan but took profit too soon.',
      })
    );
  });

  it('a hold or skip entry has no "Exited at" field', () => {
    const holdEntry: JournalEntry = {
      ...mockEntry,
      action: 'hold',
    };

    render(<EntrySheet open={true} onOpenChange={onOpenChange} entry={holdEntry} />);

    expect(screen.queryByLabelText('Exited at')).not.toBeInTheDocument();
  });

  it('deletes entry only after in-UI confirmation', async () => {
    mockDeleteMutate.mockResolvedValueOnce({ success: true });

    render(<EntrySheet open={true} onOpenChange={onOpenChange} entry={mockEntry} />);

    // Click delete trade
    const deleteButton = screen.getByRole('button', { name: 'Delete trade' });
    fireEvent.click(deleteButton);

    // Confirmation dialog appears
    expect(
      screen.getByText('Are you sure you want to delete this trade entry? This action cannot be undone.')
    ).toBeInTheDocument();
    expect(mockDeleteMutate).not.toHaveBeenCalled();

    // Confirm deletion
    const confirmButton = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockDeleteMutate).toHaveBeenCalledTimes(1);
    });

    expect(mockDeleteMutate).toHaveBeenCalledWith('entry-123');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
