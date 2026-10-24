import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KellyPanel } from './KellyPanel';
import type { KellySuggestion } from '@/types/journal-analytics';

describe('KellyPanel', () => {
  it('renders the reliable case with half Kelly percent and each field', () => {
    const suggestion: KellySuggestion = {
      fraction: 0.25,
      halfFraction: 0.125,
      winRate: 0.595,
      avgWinPercent: 6.2,
      avgLossPercent: 3.4,
      sampleSize: 42,
      reliable: true,
    };

    render(<KellyPanel suggestion={suggestion} />);

    expect(screen.getByRole('heading', { name: 'Position size (Kelly)' })).toBeInTheDocument();
    expect(screen.getByText('12.5%')).toBeInTheDocument();
    expect(screen.getByText('of equity per trade (half Kelly)')).toBeInTheDocument();

    expect(screen.getByText('Full Kelly')).toBeInTheDocument();
    expect(screen.getByText('25.0%')).toBeInTheDocument();

    expect(screen.getByText('Win rate')).toBeInTheDocument();
    expect(screen.getByText('59.5%')).toBeInTheDocument();

    expect(screen.getByText('Average win')).toBeInTheDocument();
    expect(screen.getByText('6.2%')).toBeInTheDocument();

    expect(screen.getByText('Average loss')).toBeInTheDocument();
    expect(screen.getByText('3.4%')).toBeInTheDocument();

    expect(screen.getByText('Closed trades used')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();

    expect(
      screen.getByText(
        'From your own closed trades in this journal. Half Kelly is the usual practical size. It assumes your past win rate and win and loss sizes continue, which is not guaranteed.'
      )
    ).toBeInTheDocument();
  });

  it('renders the not reliable state with the sample size notice', () => {
    const suggestion: KellySuggestion = {
      fraction: 0,
      halfFraction: 0,
      winRate: 0.5,
      avgWinPercent: 2.5,
      avgLossPercent: 2.0,
      sampleSize: 12,
      reliable: false,
    };

    render(<KellyPanel suggestion={suggestion} />);

    expect(screen.getByRole('heading', { name: 'Position size (Kelly)' })).toBeInTheDocument();
    expect(
      screen.getByText('Not enough trades for a size suggestion yet.')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'It needs at least 20 closed trades that include both wins and losses. You have 12.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText('of equity per trade (half Kelly)')).not.toBeInTheDocument();
  });

  it('renders zero Full Kelly with the no-edge note', () => {
    const suggestion: KellySuggestion = {
      fraction: 0,
      halfFraction: 0,
      winRate: 0.35,
      avgWinPercent: 2.0,
      avgLossPercent: 4.0,
      sampleSize: 28,
      reliable: true,
    };

    render(<KellyPanel suggestion={suggestion} />);

    expect(screen.getByRole('heading', { name: 'Position size (Kelly)' })).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByText('of equity per trade')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your closed trades show no edge after their own win and loss sizes, so the suggestion is not to size up.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Full Kelly')).toBeInTheDocument();
    expect(screen.getByText('0.0%')).toBeInTheDocument();
  });
});
