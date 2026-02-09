import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EquityCurveChart } from './EquityCurveChart';
import type { EquityPoint } from '@/lib/backtest/types';

// Mock lightweight-charts since it uses canvas
vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => ({
    addSeries: vi.fn(() => ({
      setData: vi.fn(),
    })),
    timeScale: vi.fn(() => ({
      fitContent: vi.fn(),
    })),
    applyOptions: vi.fn(),
    remove: vi.fn(),
  })),
  AreaSeries: 'AreaSeries',
  ColorType: { Solid: 'Solid' },
}));

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
  unobserve() {}
});

const mockEquityCurve: EquityPoint[] = [
  { bar: 0, time: 1704067200000, equity: 10000, drawdown: 0 },
  { bar: 1, time: 1704070800000, equity: 10100, drawdown: 0 },
  { bar: 2, time: 1704074400000, equity: 10250, drawdown: 0 },
];

describe('EquityCurveChart', () => {
  it('renders chart container', () => {
    render(<EquityCurveChart equityCurve={mockEquityCurve} startEquity={10000} />);
    expect(screen.getByTestId('equity-curve-chart')).toBeInTheDocument();
  });

  it('shows title', () => {
    render(<EquityCurveChart equityCurve={mockEquityCurve} startEquity={10000} />);
    expect(screen.getByText('Equity Curve')).toBeInTheDocument();
  });

  it('shows empty state when no data', () => {
    render(<EquityCurveChart equityCurve={[]} startEquity={10000} />);
    expect(screen.getByTestId('equity-chart-empty')).toBeInTheDocument();
    expect(screen.getByText('Run a backtest to see the equity curve')).toBeInTheDocument();
  });

  it('renders chart container when data provided', () => {
    render(<EquityCurveChart equityCurve={mockEquityCurve} startEquity={10000} />);
    expect(screen.getByTestId('equity-chart-container')).toBeInTheDocument();
  });
});
