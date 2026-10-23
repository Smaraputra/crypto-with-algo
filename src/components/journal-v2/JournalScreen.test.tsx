import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { JournalScreen } from './JournalScreen';
import { useRouter, useSearchParams } from 'next/navigation';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  usePathname: vi.fn(() => '/journal'),
  useSearchParams: vi.fn(),
}));

vi.mock('./TradesView', () => ({
  TradesView: () => <div data-testid="trades-view">Trades View Component</div>,
}));

vi.mock('./StatsView', () => ({
  StatsView: () => <div data-testid="stats-view">Stats View Component</div>,
}));

vi.mock('./LogTradeSheet', () => ({
  LogTradeSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="log-trade-sheet">Log Trade Sheet</div> : null,
}));

vi.mock('./EntrySheet', () => ({
  EntrySheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="entry-sheet">Entry Sheet</div> : null,
}));

function mockParams(query = ''): ReturnType<typeof useSearchParams> {
  return new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>;
}

describe('JournalScreen', () => {
  const mockPush = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: mockPush,
    } as unknown as ReturnType<typeof useRouter>);
  });

  it('renders TradesView by default when ?view is not set', () => {
    vi.mocked(useSearchParams).mockReturnValue(mockParams());

    render(<JournalScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'Journal' })).toBeInTheDocument();
    expect(screen.getByTestId('trades-view')).toBeInTheDocument();
    expect(screen.queryByTestId('stats-view')).not.toBeInTheDocument();

    const tradesRadio = screen.getByRole('radio', { name: 'Trades' });
    expect(tradesRadio).toBeChecked();
  });

  it('the view follows ?view=stats and renders StatsView', () => {
    vi.mocked(useSearchParams).mockReturnValue(mockParams('view=stats'));

    render(<JournalScreen />);

    expect(screen.getByTestId('stats-view')).toBeInTheDocument();
    expect(screen.queryByTestId('trades-view')).not.toBeInTheDocument();

    const statsRadio = screen.getByRole('radio', { name: 'Stats' });
    expect(statsRadio).toBeChecked();
  });

  it('the Notes link points to /notes', () => {
    vi.mocked(useSearchParams).mockReturnValue(mockParams());

    render(<JournalScreen />);

    const notesLink = screen.getByRole('link', { name: 'Notes' });
    expect(notesLink).toBeInTheDocument();
    expect(notesLink).toHaveAttribute('href', '/notes');
  });

  it('switching view updates the URL query parameter', () => {
    vi.mocked(useSearchParams).mockReturnValue(mockParams());

    render(<JournalScreen />);

    const statsOption = screen.getByLabelText('Stats');
    fireEvent.click(statsOption);

    expect(mockPush).toHaveBeenCalledWith('/journal?view=stats');
  });

  it('clicking Log a trade button opens LogTradeSheet', () => {
    vi.mocked(useSearchParams).mockReturnValue(mockParams());

    render(<JournalScreen />);

    expect(screen.queryByTestId('log-trade-sheet')).not.toBeInTheDocument();

    const logButton = screen.getByRole('button', { name: 'Log a trade' });
    fireEvent.click(logButton);

    expect(screen.getByTestId('log-trade-sheet')).toBeInTheDocument();
  });
});
