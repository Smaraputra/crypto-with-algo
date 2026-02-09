import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BacktestProgress } from './BacktestProgress';

describe('BacktestProgress', () => {
  it('renders progress bar', () => {
    render(<BacktestProgress progress={50} barsProcessed={150} totalBars={300} />);
    expect(screen.getByTestId('backtest-progress')).toBeInTheDocument();
  });

  it('displays bars processed count', () => {
    render(<BacktestProgress progress={50} barsProcessed={150} totalBars={300} />);
    expect(screen.getByText('150 / 300 (50%)')).toBeInTheDocument();
  });

  it('renders progressbar role', () => {
    render(<BacktestProgress progress={75} barsProcessed={225} totalBars={300} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '75');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('shows processing text', () => {
    render(<BacktestProgress progress={0} barsProcessed={0} totalBars={300} />);
    expect(screen.getByText('Processing bars...')).toBeInTheDocument();
  });
});
