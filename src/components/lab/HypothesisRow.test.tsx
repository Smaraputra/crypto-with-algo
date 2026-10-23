import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HypothesisRow, type HypothesisViewLike } from './HypothesisRow';

describe('HypothesisRow', () => {
  const sampleHypothesis: HypothesisViewLike = {
    id: 'L3-8h',
    candidate: 'L3',
    timeframe: '8h',
    status: 'under_test',
    underTestSince: '2026-01-01T00:00:00.000Z',
    testEndsAt: '2028-01-01T00:00:00.000Z',
    gradedBars: 120,
    betBars: 14,
    e: 1.9,
    threshold: 800,
    latestBar: {
      barClose: '2026-10-23T08:00:00.000Z',
    },
  };

  it('renders display name from mapping for L3-8h as an h3 heading', () => {
    render(<HypothesisRow hypothesis={sampleHypothesis} />);
    expect(
      screen.getByRole('heading', { level: 3, name: 'Volatility fade, 8 hours' })
    ).toBeInTheDocument();
    expect(screen.getByText('Volatility fade, 8 hours')).toBeInTheDocument();
    expect(screen.getByText('L3-8h')).toBeInTheDocument();
  });

  it('renders EvidenceChip with Under test', () => {
    render(<HypothesisRow hypothesis={sampleHypothesis} />);
    expect(screen.getByText('Under test')).toBeInTheDocument();
  });

  it('renders Tape with correct fill width for e 1.9 / 800 (0.2375%)', () => {
    render(<HypothesisRow hypothesis={sampleHypothesis} />);
    const fill = screen.getByTestId('tape-fill');
    expect(fill).toHaveStyle({ width: '0.2375%' });
  });

  it('renders the bets and evidence text line', () => {
    render(<HypothesisRow hypothesis={sampleHypothesis} />);
    expect(screen.getByText(/14 bets\. Evidence 1\.9 of 800 needed\./)).toBeInTheDocument();
  });

  it('renders updated relative time when latestBar.barClose is present', () => {
    render(<HypothesisRow hypothesis={sampleHypothesis} />);
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
  });

  it('renders details disclosure with under test since, test ends, graded bars, and latest bar', () => {
    render(<HypothesisRow hypothesis={sampleHypothesis} />);
    expect(screen.getByText('Record details')).toBeInTheDocument();
    expect(screen.getByText('Under test since')).toBeInTheDocument();
    expect(screen.getByText('2026-01-01')).toBeInTheDocument();
    expect(screen.getByText('Test ends')).toBeInTheDocument();
    expect(screen.getByText('2028-01-01')).toBeInTheDocument();
    expect(screen.getByText('Graded bars')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('Latest bar')).toBeInTheDocument();
    expect(screen.getByText('2026-10-23 08:00 UTC')).toBeInTheDocument();
  });

  it('renders not_shown hypothesis with Not shown chip and ended line instead of bets line', () => {
    const notShown: HypothesisViewLike = {
      ...sampleHypothesis,
      status: 'not_shown',
    };
    render(<HypothesisRow hypothesis={notShown} />);
    expect(screen.getByText('Not shown')).toBeInTheDocument();
    expect(
      screen.getByText('Its 24 months ended without reaching the bar. It keeps no claim.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/bets\. Evidence/)).not.toBeInTheDocument();
  });

  it('renders "Not yet" for missing date or bar time instead of "None"', () => {
    const missingDatesHypothesis: HypothesisViewLike = {
      ...sampleHypothesis,
      underTestSince: null,
      testEndsAt: null,
      latestBar: null,
    };
    render(<HypothesisRow hypothesis={missingDatesHypothesis} />);
    const notYetElements = screen.getAllByText('Not yet');
    expect(notYetElements.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('None')).not.toBeInTheDocument();
  });

  it('renders no chip text when showChip is false', () => {
    render(<HypothesisRow hypothesis={sampleHypothesis} showChip={false} />);
    expect(screen.queryByText('Under test')).not.toBeInTheDocument();
  });

  it('renders the chip by default', () => {
    render(<HypothesisRow hypothesis={sampleHypothesis} />);
    expect(screen.getAllByText('Under test')).toHaveLength(1);
  });

  it('gives the Record details summary an aria-hidden chevron svg', () => {
    render(<HypothesisRow hypothesis={sampleHypothesis} />);
    const summary = screen.getByText('Record details').closest('summary');
    expect(summary?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });
});
