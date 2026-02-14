import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WinRateByTag } from './WinRateByTag';
import type { TagPerformance } from '@/types/journal-analytics';

const mockData: TagPerformance[] = [
  { tag: 'breakout', count: 10, wins: 7, losses: 3, winRate: 70, avgPnlPercent: 3.2 },
  { tag: 'reversal', count: 5, wins: 2, losses: 3, winRate: 40, avgPnlPercent: -1.5 },
];

describe('WinRateByTag', () => {
  it('shows empty state when no data', () => {
    render(<WinRateByTag data={[]} />);
    expect(screen.getByTestId('win-rate-empty')).toBeInTheDocument();
  });

  it('renders tag bars', () => {
    render(<WinRateByTag data={mockData} />);
    expect(screen.getByTestId('win-rate-by-tag')).toBeInTheDocument();
    expect(screen.getByText('breakout')).toBeInTheDocument();
    expect(screen.getByText('reversal')).toBeInTheDocument();
  });

  it('shows win rate percentage', () => {
    render(<WinRateByTag data={mockData} />);
    expect(screen.getByText('70% (10 trades)')).toBeInTheDocument();
    expect(screen.getByText('40% (5 trades)')).toBeInTheDocument();
  });

  it('shows wins/losses count', () => {
    render(<WinRateByTag data={mockData} />);
    expect(screen.getByText('7W / 3L')).toBeInTheDocument();
    expect(screen.getByText('2W / 3L')).toBeInTheDocument();
  });

  it('uses green color for winning tags', () => {
    render(<WinRateByTag data={mockData} />);
    const bar = screen.getByTestId('tag-bar-breakout');
    expect(bar.className).toContain('bg-bullish');
  });

  it('uses red color for losing tags', () => {
    render(<WinRateByTag data={mockData} />);
    const bar = screen.getByTestId('tag-bar-reversal');
    expect(bar.className).toContain('bg-bearish');
  });
});
