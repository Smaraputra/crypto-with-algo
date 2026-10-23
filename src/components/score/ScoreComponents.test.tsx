import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScoreComponents } from './ScoreComponents';
import type { SignalComponent } from '@/types/signal';

vi.mock('@/hooks/useSignals', () => ({
  useLatestSignalForStyle: vi.fn().mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  }),
}));

describe('ScoreComponents', () => {
  const fixtureComponents: SignalComponent[] = [
    {
      category: 'trend',
      score: 80,
      weight: 0.25,
      weightedScore: 20.0,
      signals: [],
    },
    {
      category: 'momentum',
      score: -40,
      weight: 0.25,
      weightedScore: -10.0,
      signals: [],
    },
    {
      category: 'volume',
      score: 20,
      weight: 0.25,
      weightedScore: 5.0,
      signals: [],
    },
  ];

  it('renders bar widths true to scale for a fixture', () => {
    render(<ScoreComponents components={fixtureComponents} />);

    // Max absolute extent is 20.0 (trend)
    // trend (+20): 100.0% of positive side
    // momentum (-10): 50.0% of negative side
    // volume (+5): 25.0% of positive side

    const trendBar = screen.getByTestId('bar-trend');
    const momentumBar = screen.getByTestId('bar-momentum');
    const volumeBar = screen.getByTestId('bar-volume');

    expect(trendBar).toHaveStyle({ width: '100.0%' });
    expect(momentumBar).toHaveStyle({ width: '50.0%' });
    expect(volumeBar).toHaveStyle({ width: '25.0%' });

    const trendWidth = parseFloat(trendBar.style.width);
    const momentumWidth = parseFloat(momentumBar.style.width);
    const volumeWidth = parseFloat(volumeBar.style.width);

    expect(trendWidth / momentumWidth).toBeCloseTo(2.0);
    expect(momentumWidth / volumeWidth).toBeCloseTo(2.0);
  });

  it('provides a text alternative that names every value', () => {
    render(<ScoreComponents components={fixtureComponents} />);

    const region = screen.getByRole('region');
    expect(region).toHaveAttribute(
      'aria-label',
      'What moved the score: Trend: +20.0, Momentum: -10.0, Volume: +5.0'
    );

    expect(
      screen.getByText('Trend: +20.0, Momentum: -10.0, Volume: +5.0')
    ).toHaveClass('sr-only');
  });

  it('displays custom component label when provided', () => {
    const customComponents: SignalComponent[] = [
      {
        category: 'trend',
        score: 50,
        weight: 0.5,
        weightedScore: 10,
        signals: [],
        ...({ label: 'Moving averages' } as unknown as object),
      },
    ];

    render(<ScoreComponents components={customComponents} />);

    expect(screen.getByText('Moving averages')).toBeInTheDocument();
  });

  it('renders nothing when no components are available', () => {
    const { container } = render(<ScoreComponents components={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('What moved the score')).not.toBeInTheDocument();
  });

  it('renders nothing when there is no signal for chosen coin, style and interval', () => {
    const { container } = render(
      <ScoreComponents symbol="BTCUSDT" style="day_trading" interval="1h" />
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('What moved the score')).not.toBeInTheDocument();
  });
});
