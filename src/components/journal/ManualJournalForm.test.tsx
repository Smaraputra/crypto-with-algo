import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockMutate = vi.fn();

vi.mock('@/hooks/useJournal', () => ({
  useCreateJournalEntry: vi.fn(() => ({
    mutate: mockMutate,
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

import { ManualJournalForm } from './ManualJournalForm';

describe('ManualJournalForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders New Entry button', () => {
    render(<ManualJournalForm />);
    expect(screen.getByTestId('new-entry-button')).toBeInTheDocument();
    expect(screen.getByText('New Entry')).toBeInTheDocument();
  });

  it('opens dialog on button click', async () => {
    render(<ManualJournalForm />);
    fireEvent.click(screen.getByTestId('new-entry-button'));
    await waitFor(() => {
      expect(screen.getByText('New Journal Entry')).toBeInTheDocument();
    });
  });

  it('shows symbol select with common symbols', async () => {
    render(<ManualJournalForm />);
    fireEvent.click(screen.getByTestId('new-entry-button'));
    await waitFor(() => {
      expect(screen.getByTestId('symbol-select')).toBeInTheDocument();
    });
  });

  it('shows interval buttons', async () => {
    render(<ManualJournalForm />);
    fireEvent.click(screen.getByTestId('new-entry-button'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '15m' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '1h' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '4h' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '1d' })).toBeInTheDocument();
    });
  });

  it('shows action buttons', async () => {
    render(<ManualJournalForm />);
    fireEvent.click(screen.getByTestId('new-entry-button'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /buy/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /sell/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /hold/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /skip/i })).toBeInTheDocument();
    });
  });

  it('shows entry price input', async () => {
    render(<ManualJournalForm />);
    fireEvent.click(screen.getByTestId('new-entry-button'));
    await waitFor(() => {
      expect(screen.getByTestId('entry-price-input')).toBeInTheDocument();
    });
  });

  it('shows save button', async () => {
    render(<ManualJournalForm />);
    fireEvent.click(screen.getByTestId('new-entry-button'));
    await waitFor(() => {
      expect(screen.getByTestId('save-entry-button')).toBeInTheDocument();
    });
  });

  it('calls createEntry.mutate on submit', async () => {
    render(<ManualJournalForm />);
    fireEvent.click(screen.getByTestId('new-entry-button'));
    await waitFor(() => {
      expect(screen.getByTestId('save-entry-button')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('save-entry-button'));
    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTCUSDT',
        interval: '1h',
        signalScore: 0,
        signalTier: 'neutral',
        action: 'buy',
      }),
      expect.any(Object)
    );
  });

  it('toggles notes preview mode', async () => {
    render(<ManualJournalForm />);
    fireEvent.click(screen.getByTestId('new-entry-button'));
    await waitFor(() => {
      expect(screen.getByTestId('journal-notes')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    expect(screen.queryByTestId('journal-notes')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(screen.getByTestId('journal-notes')).toBeInTheDocument();
  });
});
