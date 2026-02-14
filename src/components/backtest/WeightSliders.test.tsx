import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WeightSliders } from './WeightSliders';
import { DEFAULT_WEIGHTS } from '@/types/signal';

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
  unobserve() {}
});

describe('WeightSliders', () => {
  const defaultProps = {
    weights: { ...DEFAULT_WEIGHTS },
    onChange: vi.fn(),
  };

  it('renders weight sliders container', () => {
    render(<WeightSliders {...defaultProps} />);
    expect(screen.getByTestId('weight-sliders')).toBeInTheDocument();
  });

  it('renders all 6 weight labels', () => {
    render(<WeightSliders {...defaultProps} />);
    expect(screen.getByText('Trend')).toBeInTheDocument();
    expect(screen.getByText('Momentum')).toBeInTheDocument();
    expect(screen.getByText('Volume')).toBeInTheDocument();
    expect(screen.getByText('Volatility')).toBeInTheDocument();
    expect(screen.getByText('Futures')).toBeInTheDocument();
    expect(screen.getByText('Sentiment')).toBeInTheDocument();
  });

  it('renders 6 sliders', () => {
    render(<WeightSliders {...defaultProps} />);
    const sliders = screen.getAllByRole('slider');
    expect(sliders).toHaveLength(6);
  });

  it('shows total as 100% with default weights', () => {
    render(<WeightSliders {...defaultProps} />);
    expect(screen.getByTestId('weight-total')).toHaveTextContent('Total: 100%');
  });

  it('shows total in green when valid', () => {
    render(<WeightSliders {...defaultProps} />);
    const total = screen.getByTestId('weight-total');
    expect(total.className).toContain('text-bullish');
  });

  it('shows total in red when invalid', () => {
    const invalidWeights = { ...DEFAULT_WEIGHTS, trend: 0.5 };
    render(<WeightSliders {...defaultProps} weights={invalidWeights} />);
    const total = screen.getByTestId('weight-total');
    expect(total.className).toContain('text-bearish');
  });

  it('renders Weights label', () => {
    render(<WeightSliders {...defaultProps} />);
    expect(screen.getByText('Weights')).toBeInTheDocument();
  });
});
