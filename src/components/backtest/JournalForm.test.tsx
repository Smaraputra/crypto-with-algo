import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/hooks/useJournal', () => ({
  useCreateJournalEntry: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
  unobserve() {}
});

import { JournalForm } from './JournalForm';

describe('JournalForm', () => {
  it('renders log to journal button', () => {
    render(
      <JournalForm symbol="BTCUSDT" interval="1h" score={45} tier="buy" />
    );
    expect(screen.getByTestId('log-journal-button')).toBeInTheDocument();
  });

  it('opens dialog on button click', () => {
    render(
      <JournalForm symbol="BTCUSDT" interval="1h" score={45} tier="buy" />
    );
    fireEvent.click(screen.getByTestId('log-journal-button'));
    expect(screen.getByText('Log Signal to Journal')).toBeInTheDocument();
  });

  it('shows signal details in dialog', () => {
    render(
      <JournalForm symbol="BTCUSDT" interval="1h" score={45} tier="buy" />
    );
    fireEvent.click(screen.getByTestId('log-journal-button'));
    expect(screen.getByText('BTCUSDT')).toBeInTheDocument();
    expect(screen.getByText('Score: 45')).toBeInTheDocument();
  });

  it('shows action buttons', () => {
    render(
      <JournalForm symbol="BTCUSDT" interval="1h" score={45} tier="buy" />
    );
    fireEvent.click(screen.getByTestId('log-journal-button'));
    // Action buttons: buy, sell, hold, skip
    const actionButtons = screen.getAllByRole('button').filter(
      (btn) => ['buy', 'sell', 'hold', 'skip'].includes(btn.textContent?.trim() ?? '')
    );
    expect(actionButtons).toHaveLength(4);
  });

  it('has a save button', () => {
    render(
      <JournalForm symbol="BTCUSDT" interval="1h" score={45} tier="buy" />
    );
    fireEvent.click(screen.getByTestId('log-journal-button'));
    expect(screen.getByText('Save Entry')).toBeInTheDocument();
  });
});
