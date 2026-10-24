import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EntryScreenshots } from './EntryScreenshots';
import * as journalHooks from '@/hooks/useJournal';
import type { JournalEntry } from '@/types/journal';

vi.mock('@/hooks/useJournal', () => ({
  useUploadJournalScreenshot: vi.fn(),
  useDeleteJournalScreenshot: vi.fn(),
}));

const mockEntryWithScreenshots: JournalEntry = {
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
  notes: '',
  reviewedAt: null,
  tags: [],
  indicatorSnapshot: null,
  strategyId: null,
  backtestResultId: null,
  lessonsLearned: '',
  reviewHistory: [],
  setupType: '',
  marketCondition: null,
  emotion: null,
  mistakes: [],
  convictionLevel: null,
  plannedRiskReward: null,
  sentiment: null,
  screenshots: [
    {
      fileId: 'file-1',
      contentType: 'image/png',
      size: 1024,
      uploadedAt: '2026-10-24T10:00:00.000Z',
    },
    {
      fileId: 'file-2',
      contentType: 'image/jpeg',
      size: 2048,
      uploadedAt: '2026-10-24T10:05:00.000Z',
    },
  ],
  createdAt: '2026-10-24T10:00:00.000Z',
  updatedAt: '2026-10-24T10:05:00.000Z',
};

describe('EntryScreenshots', () => {
  const mockUploadMutate = vi.fn();
  const mockDeleteMutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(journalHooks.useUploadJournalScreenshot).mockReturnValue({
      mutateAsync: mockUploadMutate,
      isPending: false,
    } as unknown as ReturnType<typeof journalHooks.useUploadJournalScreenshot>);

    vi.mocked(journalHooks.useDeleteJournalScreenshot).mockReturnValue({
      mutateAsync: mockDeleteMutate,
      isPending: false,
    } as unknown as ReturnType<typeof journalHooks.useDeleteJournalScreenshot>);
  });

  it('renders thumbnails with correct src and alt attributes', () => {
    render(<EntryScreenshots entry={mockEntryWithScreenshots} />);

    expect(screen.getByRole('heading', { name: 'Screenshots' })).toBeInTheDocument();

    const thumb1Btn = screen.getByRole('button', { name: 'View screenshot 1' });
    const img1 = thumb1Btn.querySelector('img')!;
    expect(img1).toHaveAttribute('src', '/api/journal/screenshots/file-1');
    expect(img1).toHaveAttribute('alt', 'Screenshot 1 of the BTC trade');

    const thumb2Btn = screen.getByRole('button', { name: 'View screenshot 2' });
    const img2 = thumb2Btn.querySelector('img')!;
    expect(img2).toHaveAttribute('src', '/api/journal/screenshots/file-2');
    expect(img2).toHaveAttribute('alt', 'Screenshot 2 of the BTC trade');
  });

  it('opens dialog on thumbnail click and allows removing screenshot with confirmation', async () => {
    mockDeleteMutate.mockResolvedValueOnce({ success: true });
    render(<EntryScreenshots entry={mockEntryWithScreenshots} />);

    // Click thumbnail 1 to open dialog
    fireEvent.click(screen.getByRole('button', { name: 'View screenshot 1' }));

    expect(screen.getByRole('heading', { name: 'Screenshot 1' })).toBeInTheDocument();

    // Click "Remove screenshot"
    const removeBtn = screen.getByRole('button', { name: 'Remove screenshot' });
    fireEvent.click(removeBtn);

    // Confirmation appears
    expect(
      screen.getByText('Remove this screenshot? This cannot be undone.')
    ).toBeInTheDocument();
    expect(mockDeleteMutate).not.toHaveBeenCalled();

    // Click "Keep" cancels confirmation
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(
      screen.queryByText('Remove this screenshot? This cannot be undone.')
    ).not.toBeInTheDocument();

    // Click "Remove screenshot" again
    fireEvent.click(screen.getByRole('button', { name: 'Remove screenshot' }));

    // Click confirmed "Remove"
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(mockDeleteMutate).toHaveBeenCalledTimes(1);
    });

    expect(mockDeleteMutate).toHaveBeenCalledWith({
      fileId: 'file-1',
      entryId: 'entry-123',
    });
  });

  it('hides drop zone upload button when entry has 4 screenshots', () => {
    const fullEntry: JournalEntry = {
      ...mockEntryWithScreenshots,
      screenshots: [
        { fileId: 'f1', contentType: 'image/png', size: 100, uploadedAt: '' },
        { fileId: 'f2', contentType: 'image/png', size: 100, uploadedAt: '' },
        { fileId: 'f3', contentType: 'image/png', size: 100, uploadedAt: '' },
        { fileId: 'f4', contentType: 'image/png', size: 100, uploadedAt: '' },
      ],
    };

    render(<EntryScreenshots entry={fullEntry} />);

    expect(
      screen.getByText('This entry has 4 screenshots, the most it can hold.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose images' })).not.toBeInTheDocument();
  });
});
