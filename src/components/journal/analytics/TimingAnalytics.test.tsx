import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimingAnalytics } from './TimingAnalytics';

const bySession = [
  { session: 'ny_overlap', count: 2, wins: 0, winRate: 0, avgPnlPercent: -1.5 },
  { session: 'asia', count: 4, wins: 3, winRate: 75, avgPnlPercent: 2 },
];
const byHour = [{ hour: 9, count: 3, wins: 2, winRate: 66.7, avgPnlPercent: 1.5 }];
const byWeekday = [{ weekday: 1, count: 4, wins: 3, winRate: 75, avgPnlPercent: 1.5 }];

describe('TimingAnalytics', () => {
  it('renders the three timing columns', () => {
    render(<TimingAnalytics bySession={bySession} byHour={byHour} byWeekday={byWeekday} />);

    expect(screen.getByTestId('timing-analytics')).toBeInTheDocument();
    expect(screen.getByText('By Session (UTC)')).toBeInTheDocument();
    expect(screen.getByText('By Hour (UTC)')).toBeInTheDocument();
    expect(screen.getByText('By Weekday (UTC)')).toBeInTheDocument();
    expect(screen.getByText('Asia')).toBeInTheDocument();
    expect(screen.getByText('09:00')).toBeInTheDocument();
    expect(screen.getByText('Mon')).toBeInTheDocument();
  });

  it('sorts sessions in taxonomy order', () => {
    render(<TimingAnalytics bySession={bySession} byHour={[]} byWeekday={[]} />);

    const items = screen.getAllByText(/Asia|London\/NY Overlap/);
    expect(items[0]).toHaveTextContent('Asia');
  });

  it('shows an empty state without data', () => {
    render(<TimingAnalytics bySession={[]} byHour={[]} byWeekday={[]} />);
    expect(screen.getByTestId('timing-empty')).toBeInTheDocument();
  });
});
