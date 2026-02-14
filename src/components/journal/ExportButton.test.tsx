import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/hooks/useJournal', () => ({
  useJournalEntries: vi.fn(),
}));

import { ExportButton } from './ExportButton';
import { useJournalEntries } from '@/hooks/useJournal';

describe('ExportButton', () => {
  it('renders export button', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [] },
      isLoading: false,
    } as never);

    render(<ExportButton />);
    expect(screen.getByTestId('export-csv-button')).toBeInTheDocument();
    expect(screen.getByText('Export CSV')).toBeInTheDocument();
  });

  it('is disabled when loading', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as never);

    render(<ExportButton />);
    expect(screen.getByTestId('export-csv-button')).toBeDisabled();
  });

  it('is disabled when no entries', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: { entries: [] },
      isLoading: false,
    } as never);

    render(<ExportButton />);
    expect(screen.getByTestId('export-csv-button')).toBeDisabled();
  });

  it('is enabled when entries exist', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: {
        entries: [
          {
            _id: '1',
            symbol: 'BTCUSDT',
            interval: '1h',
            action: 'buy',
            signalScore: 50,
            signalTier: 'buy',
            entryPrice: 50000,
            exitPrice: null,
            outcomePnlPercent: null,
            notes: '',
            tags: [],
            setupType: '',
            marketCondition: null,
            reviewedAt: null,
            createdAt: '2025-01-01T00:00:00Z',
          },
        ],
      },
      isLoading: false,
    } as never);

    render(<ExportButton />);
    expect(screen.getByTestId('export-csv-button')).not.toBeDisabled();
  });

  it('triggers download on click', () => {
    vi.mocked(useJournalEntries).mockReturnValue({
      data: {
        entries: [
          {
            _id: '1',
            symbol: 'BTCUSDT',
            interval: '1h',
            action: 'buy',
            signalScore: 50,
            signalTier: 'buy',
            entryPrice: 50000,
            exitPrice: null,
            outcomePnlPercent: null,
            notes: 'Test',
            tags: ['tag1'],
            setupType: 'breakout',
            marketCondition: 'trending_up',
            reviewedAt: null,
            createdAt: '2025-01-01T00:00:00Z',
          },
        ],
      },
      isLoading: false,
    } as never);

    render(<ExportButton />);

    const revokeObjectURL = vi.fn();
    const createObjectURL = vi.fn(() => 'blob:test');
    global.URL.createObjectURL = createObjectURL;
    global.URL.revokeObjectURL = revokeObjectURL;

    const mockClick = vi.fn();
    const mockAnchor = { href: '', download: '', click: mockClick };
    vi.spyOn(document, 'createElement').mockReturnValueOnce(
      mockAnchor as unknown as HTMLAnchorElement
    );

    fireEvent.click(screen.getByTestId('export-csv-button'));
    expect(createObjectURL).toHaveBeenCalled();
    expect(mockClick).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});
