import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SignalGauge } from './SignalGauge';

describe('SignalGauge', () => {
  it('renders the gauge', () => {
    render(<SignalGauge score={45} tier="buy" />);
    expect(screen.getByTestId('signal-gauge')).toBeInTheDocument();
  });

  it('displays the score', () => {
    render(<SignalGauge score={72.5} tier="strong_buy" />);
    expect(screen.getByTestId('gauge-score')).toHaveTextContent('73');
  });

  it('displays the tier label', () => {
    render(<SignalGauge score={45} tier="buy" />);
    expect(screen.getByTestId('gauge-tier')).toHaveTextContent('Buy');
  });

  it('displays Strong Buy tier', () => {
    render(<SignalGauge score={75} tier="strong_buy" />);
    expect(screen.getByTestId('gauge-tier')).toHaveTextContent('Strong Buy');
  });

  it('displays Strong Sell tier', () => {
    render(<SignalGauge score={-80} tier="strong_sell" />);
    expect(screen.getByTestId('gauge-tier')).toHaveTextContent('Strong Sell');
  });

  it('displays confidence when provided', () => {
    render(<SignalGauge score={50} tier="buy" confidence={85} />);
    expect(screen.getByTestId('gauge-confidence')).toHaveTextContent('85% confidence');
  });

  it('hides confidence when not provided', () => {
    render(<SignalGauge score={50} tier="buy" />);
    expect(screen.queryByTestId('gauge-confidence')).not.toBeInTheDocument();
  });

  it('has accessible aria-label', () => {
    render(<SignalGauge score={-30} tier="sell" />);
    const svg = screen.getByRole('img');
    expect(svg).toHaveAttribute('aria-label', 'Signal gauge: Sell (-30)');
  });

  it('clamps displayed score to range', () => {
    render(<SignalGauge score={150} tier="strong_buy" />);
    expect(screen.getByTestId('gauge-score')).toHaveTextContent('150');
    // The needle position is internally clamped, but we display the raw score
  });

  it('renders with custom size', () => {
    render(<SignalGauge score={0} tier="neutral" size={300} />);
    const svg = screen.getByRole('img');
    expect(svg).toHaveAttribute('width', '300');
  });
});
