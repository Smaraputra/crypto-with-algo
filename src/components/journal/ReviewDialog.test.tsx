import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/hooks/useJournal', () => ({
  useReviewJournalEntry: vi.fn(() => ({
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

import { ReviewDialog } from './ReviewDialog';
import { mockJournalEntry2 } from '@/__fixtures__/journal';

describe('ReviewDialog', () => {
  it('renders review trigger button', () => {
    render(<ReviewDialog entry={mockJournalEntry2} />);
    expect(screen.getByText('Review')).toBeInTheDocument();
  });

  it('opens dialog on trigger click', () => {
    render(<ReviewDialog entry={mockJournalEntry2} />);
    fireEvent.click(screen.getByText('Review'));
    expect(screen.getByRole('heading', { name: 'Review Trade' })).toBeInTheDocument();
  });

  it('shows trade summary in dialog', () => {
    render(<ReviewDialog entry={mockJournalEntry2} />);
    fireEvent.click(screen.getByText('Review'));
    expect(screen.getByText('ETHUSDT')).toBeInTheDocument();
    expect(screen.getByText('sell')).toBeInTheDocument();
  });

  it('shows P&L when available', () => {
    render(<ReviewDialog entry={mockJournalEntry2} />);
    fireEvent.click(screen.getByText('Review'));
    expect(screen.getByText('+4.55%')).toBeInTheDocument();
  });

  it('has lessons learned textarea', () => {
    render(<ReviewDialog entry={mockJournalEntry2} />);
    fireEvent.click(screen.getByText('Review'));
    expect(screen.getByTestId('lessons-learned-input')).toBeInTheDocument();
  });

  it('has mark as reviewed button', () => {
    render(<ReviewDialog entry={mockJournalEntry2} />);
    fireEvent.click(screen.getByText('Review'));
    expect(screen.getByText('Mark as Reviewed')).toBeInTheDocument();
  });

  it('renders custom trigger', () => {
    render(
      <ReviewDialog
        entry={mockJournalEntry2}
        trigger={<button>Custom Trigger</button>}
      />
    );
    expect(screen.getByText('Custom Trigger')).toBeInTheDocument();
  });
});
