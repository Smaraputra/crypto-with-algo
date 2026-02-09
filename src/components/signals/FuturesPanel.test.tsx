import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FuturesPanel } from './FuturesPanel';

const mockFundingRate = {
  symbol: 'BTCUSDT',
  fundingRate: 0.0001,
  fundingTime: 1700000000000,
  markPrice: 43500.25,
};

const mockOpenInterest = {
  symbol: 'BTCUSDT',
  openInterest: 123456.789,
  time: 1700000000000,
};

const mockLongShortRatio = {
  symbol: 'BTCUSDT',
  longShortRatio: 1.23,
  longAccount: 0.5525,
  shortAccount: 0.4475,
  timestamp: 1700000000000,
};

describe('FuturesPanel', () => {
  it('renders the panel', () => {
    render(<FuturesPanel fundingRate={mockFundingRate} />);
    expect(screen.getByTestId('futures-panel')).toBeInTheDocument();
  });

  it('displays funding rate', () => {
    render(<FuturesPanel fundingRate={mockFundingRate} />);
    expect(screen.getByTestId('funding-rate-value')).toHaveTextContent('0.0100%');
  });

  it('displays mark price', () => {
    render(<FuturesPanel fundingRate={mockFundingRate} />);
    expect(screen.getByText('Mark Price')).toBeInTheDocument();
    expect(screen.getByText('$43.50K')).toBeInTheDocument();
  });

  it('displays open interest', () => {
    render(<FuturesPanel openInterest={mockOpenInterest} />);
    expect(screen.getByTestId('open-interest-value')).toHaveTextContent('123.46K');
  });

  it('displays long/short ratio', () => {
    render(<FuturesPanel longShortRatio={mockLongShortRatio} />);
    expect(screen.getByTestId('ls-ratio-value')).toHaveTextContent('1.23');
  });

  it('displays long/short percentages', () => {
    render(<FuturesPanel longShortRatio={mockLongShortRatio} />);
    expect(screen.getByText('55.3%')).toBeInTheDocument();
    expect(screen.getByText('44.8%')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    render(<FuturesPanel isLoading />);
    const panel = screen.getByTestId('futures-panel');
    expect(panel.querySelectorAll('.animate-pulse')).toHaveLength(3);
  });

  it('shows empty state when no data', () => {
    render(<FuturesPanel />);
    expect(screen.getByText('No futures data available')).toBeInTheDocument();
  });

  it('renders all sections together', () => {
    render(
      <FuturesPanel
        fundingRate={mockFundingRate}
        openInterest={mockOpenInterest}
        longShortRatio={mockLongShortRatio}
      />
    );
    expect(screen.getByTestId('funding-rate-value')).toBeInTheDocument();
    expect(screen.getByTestId('open-interest-value')).toBeInTheDocument();
    expect(screen.getByTestId('ls-ratio-value')).toBeInTheDocument();
  });

  it('handles partial data (only funding rate)', () => {
    render(<FuturesPanel fundingRate={mockFundingRate} />);
    expect(screen.getByTestId('funding-rate-value')).toBeInTheDocument();
    expect(screen.queryByTestId('open-interest-value')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ls-ratio-value')).not.toBeInTheDocument();
  });
});
