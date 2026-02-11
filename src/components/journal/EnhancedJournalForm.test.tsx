import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/hooks/useJournal', () => ({
  useCreateJournalEntry: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

vi.mock('@/hooks/useIndicatorSnapshot', () => ({
  useIndicatorSnapshot: vi.fn(() => ({
    data: null,
    isLoading: false,
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

import { EnhancedJournalForm } from './EnhancedJournalForm';

const defaultProps = {
  symbol: 'BTCUSDT',
  interval: '1h',
  score: 45,
  tier: 'buy' as const,
};

describe('EnhancedJournalForm', () => {
  it('renders trigger button', () => {
    render(<EnhancedJournalForm {...defaultProps} />);
    expect(screen.getByTestId('enhanced-journal-button')).toBeInTheDocument();
  });

  it('opens dialog on button click', () => {
    render(<EnhancedJournalForm {...defaultProps} />);
    fireEvent.click(screen.getByTestId('enhanced-journal-button'));
    expect(
      screen.getByRole('heading', { name: 'Log Signal to Journal' })
    ).toBeInTheDocument();
  });

  it('shows signal context in dialog', () => {
    render(<EnhancedJournalForm {...defaultProps} />);
    fireEvent.click(screen.getByTestId('enhanced-journal-button'));
    expect(screen.getByText('BTCUSDT')).toBeInTheDocument();
    expect(screen.getByText('Score: 45')).toBeInTheDocument();
  });

  it('shows action buttons', () => {
    render(<EnhancedJournalForm {...defaultProps} />);
    fireEvent.click(screen.getByTestId('enhanced-journal-button'));
    const actionButtons = screen
      .getAllByRole('button')
      .filter((btn) =>
        ['buy', 'sell', 'hold', 'skip'].includes(btn.textContent?.trim() ?? '')
      );
    expect(actionButtons).toHaveLength(4);
  });

  it('shows setup type input', () => {
    render(<EnhancedJournalForm {...defaultProps} />);
    fireEvent.click(screen.getByTestId('enhanced-journal-button'));
    expect(screen.getByPlaceholderText(/breakout/i)).toBeInTheDocument();
  });

  it('shows tag input', () => {
    render(<EnhancedJournalForm {...defaultProps} />);
    fireEvent.click(screen.getByTestId('enhanced-journal-button'));
    expect(screen.getByTestId('tag-input')).toBeInTheDocument();
  });

  it('shows notes textarea', () => {
    render(<EnhancedJournalForm {...defaultProps} />);
    fireEvent.click(screen.getByTestId('enhanced-journal-button'));
    expect(screen.getByTestId('journal-notes')).toBeInTheDocument();
  });

  it('toggles between edit and preview for notes', () => {
    render(<EnhancedJournalForm {...defaultProps} />);
    fireEvent.click(screen.getByTestId('enhanced-journal-button'));

    // Start in edit mode, notes textarea visible
    expect(screen.getByTestId('journal-notes')).toBeInTheDocument();

    // Click Preview
    fireEvent.click(screen.getByText('Preview'));
    expect(screen.queryByTestId('journal-notes')).not.toBeInTheDocument();

    // Click Edit
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByTestId('journal-notes')).toBeInTheDocument();
  });

  it('has save button', () => {
    render(<EnhancedJournalForm {...defaultProps} />);
    fireEvent.click(screen.getByTestId('enhanced-journal-button'));
    expect(screen.getByText('Save Entry')).toBeInTheDocument();
  });

  it('has capture snapshot button', () => {
    render(<EnhancedJournalForm {...defaultProps} />);
    fireEvent.click(screen.getByTestId('enhanced-journal-button'));
    expect(screen.getByTestId('capture-snapshot-button')).toBeInTheDocument();
  });

  it('shows confidence when provided', () => {
    render(<EnhancedJournalForm {...defaultProps} confidence={85} />);
    fireEvent.click(screen.getByTestId('enhanced-journal-button'));
    expect(screen.getByText('(85% conf)')).toBeInTheDocument();
  });

  it('shows sentiment when provided', () => {
    render(
      <EnhancedJournalForm
        {...defaultProps}
        sentiment={{ fearGreedIndex: 65, fearGreedLabel: 'Greed' }}
      />
    );
    fireEvent.click(screen.getByTestId('enhanced-journal-button'));
    expect(screen.getByText('F&G: 65')).toBeInTheDocument();
  });
});
