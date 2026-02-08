import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChartLegend } from './ChartLegend';
import type { KLineData } from 'klinecharts';

const bullishBar: KLineData = {
  timestamp: 1700000000000,
  open: 50000,
  high: 51000,
  low: 49000,
  close: 51000,
  volume: 1234567,
};

const bearishBar: KLineData = {
  timestamp: 1700000000000,
  open: 51000,
  high: 52000,
  low: 49500,
  close: 49500,
  volume: 567.89,
};

describe('ChartLegend', () => {
  it('returns null when kLineData is null', () => {
    const { container } = render(<ChartLegend symbol="BTCUSDT" kLineData={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders symbol name', () => {
    render(<ChartLegend symbol="BTCUSDT" kLineData={bullishBar} />);
    expect(screen.getByText('BTCUSDT')).toBeInTheDocument();
  });

  it('renders OHLC values', () => {
    const bar: KLineData = {
      timestamp: 1700000000000,
      open: 50000,
      high: 51500,
      low: 49000,
      close: 50500,
      volume: 100,
    };
    render(<ChartLegend symbol="BTCUSDT" kLineData={bar} />);

    expect(screen.getByText('50000.00')).toBeInTheDocument(); // open
    expect(screen.getByText('51500.00')).toBeInTheDocument(); // high
    expect(screen.getByText('49000.00')).toBeInTheDocument(); // low
    expect(screen.getByText('50500.00')).toBeInTheDocument(); // close
  });

  it('renders volume formatted with M suffix', () => {
    render(<ChartLegend symbol="BTCUSDT" kLineData={bullishBar} />);
    expect(screen.getByText('1.23M')).toBeInTheDocument();
  });

  it('renders volume formatted with K suffix', () => {
    const bar = { ...bullishBar, volume: 5432 };
    render(<ChartLegend symbol="BTCUSDT" kLineData={bar} />);
    expect(screen.getByText('5.43K')).toBeInTheDocument();
  });

  it('renders small volume without suffix', () => {
    render(<ChartLegend symbol="ETHUSDT" kLineData={bearishBar} />);
    expect(screen.getByText('567.89')).toBeInTheDocument();
  });

  it('shows bullish color class when close >= open', () => {
    render(<ChartLegend symbol="BTCUSDT" kLineData={bullishBar} />);

    const legend = screen.getByTestId('chart-legend');
    const bullishElements = legend.querySelectorAll('.text-bullish');
    expect(bullishElements.length).toBeGreaterThan(0);
  });

  it('shows bearish color class when close < open', () => {
    render(<ChartLegend symbol="BTCUSDT" kLineData={bearishBar} />);

    const legend = screen.getByTestId('chart-legend');
    const bearishElements = legend.querySelectorAll('.text-bearish');
    expect(bearishElements.length).toBeGreaterThan(0);
  });

  it('shows positive change with + prefix for bullish bar', () => {
    render(<ChartLegend symbol="BTCUSDT" kLineData={bullishBar} />);
    // change = 51000 - 50000 = 1000, pct = 2%
    expect(screen.getByText(/\+1000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\+2\.00%/)).toBeInTheDocument();
  });

  it('shows negative change for bearish bar', () => {
    render(<ChartLegend symbol="BTCUSDT" kLineData={bearishBar} />);
    // change = 49500 - 51000 = -1500, pct = -2.94%
    expect(screen.getByText(/-1500\.00/)).toBeInTheDocument();
    expect(screen.getByText(/-2\.94%/)).toBeInTheDocument();
  });

  it('formats small prices with more decimal places', () => {
    const smallBar: KLineData = {
      timestamp: 1700000000000,
      open: 0.005,
      high: 0.006,
      low: 0.004,
      close: 0.0055,
      volume: 100,
    };
    render(<ChartLegend symbol="SHIBUSDT" kLineData={smallBar} />);
    expect(screen.getByText('0.00500000')).toBeInTheDocument();
  });
});
