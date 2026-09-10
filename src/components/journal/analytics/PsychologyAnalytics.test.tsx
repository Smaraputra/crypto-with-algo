import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PsychologyAnalytics } from './PsychologyAnalytics';

const byEmotion = [
  { emotion: 'fomo', count: 4, wins: 1, winRate: 25, avgPnlPercent: -1.5 },
  { emotion: 'calm', count: 10, wins: 7, winRate: 70, avgPnlPercent: 1.2 },
];
const byMistake = [
  { mistake: 'chased_entry', count: 3, avgPnlPercent: -1.5, totalPnlPercent: -4.5 },
];
const streaks = { current: { type: 'loss' as const, length: 2 }, maxWinStreak: 5, maxLossStreak: 3 };

describe('PsychologyAnalytics', () => {
  it('renders streaks, emotions, and mistake costs', () => {
    render(<PsychologyAnalytics byEmotion={byEmotion} byMistake={byMistake} streaks={streaks} />);

    expect(screen.getByTestId('psychology-analytics')).toBeInTheDocument();
    expect(screen.getByTestId('current-streak')).toHaveTextContent('Current streak: 2 losses');
    expect(screen.getByText('FOMO')).toBeInTheDocument();
    expect(screen.getByText('Calm')).toBeInTheDocument();
    expect(screen.getByText('Chased entry')).toBeInTheDocument();
    expect(screen.getByText('-4.50%')).toBeInTheDocument();
  });

  it('shows an empty state without data', () => {
    render(
      <PsychologyAnalytics
        byEmotion={[]}
        byMistake={[]}
        streaks={{ current: null, maxWinStreak: 0, maxLossStreak: 0 }}
      />
    );
    expect(screen.getByTestId('psychology-empty')).toBeInTheDocument();
  });
});
