import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScorePage } from './ScorePage';
import { useUIStore } from '@/stores/uiStore';

// Mock subcomponents to isolate ScorePage behavior
vi.mock('./ScoreReading', () => ({
  ScoreReading: () => <div data-testid="mock-score-reading">Score Reading</div>,
}));

vi.mock('./ScoreComponents', () => ({
  ScoreComponents: () => <div data-testid="mock-score-components">Score Components</div>,
}));

vi.mock('./ScoreHistory', () => ({
  ScoreHistory: () => <div data-testid="mock-score-history">Score History</div>,
}));

vi.mock('./FuturesContext', () => ({
  FuturesContext: () => <div data-testid="mock-futures-context">Futures Context</div>,
}));

describe('ScorePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ selectedSymbol: 'BTCUSDT' });
  });

  it('renders the PageHeader with dynamic base asset and /lab link', () => {
    render(<ScorePage />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Price score' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'The composite score as context for BTC. Measured on years of history: no edge after costs.'
      )
    ).toBeInTheDocument();

    const labLink = screen.getByRole('link', {
      name: 'See the full measured record on the lab page',
    });
    expect(labLink).toBeInTheDocument();
    expect(labLink).toHaveAttribute('href', '/lab');
  });

  it('coin select writes to the UI store and updates the base asset', () => {
    render(<ScorePage />);

    const coinSelect = screen.getByLabelText('Coin');
    expect(coinSelect).toHaveValue('BTCUSDT');

    fireEvent.change(coinSelect, { target: { value: 'ETHUSDT' } });

    expect(useUIStore.getState().selectedSymbol).toBe('ETHUSDT');
    expect(
      screen.getByText(
        'The composite score as context for ETH. Measured on years of history: no edge after costs.'
      )
    ).toBeInTheDocument();
  });

  it('style change updates the interval options', () => {
    render(<ScorePage />);

    // Default style: Day trading -> scoredIntervals are 15m and 1h
    expect(screen.getByLabelText('15m')).toBeInTheDocument();
    expect(screen.getByLabelText('1h')).toBeInTheDocument();

    // Switch to Scalping -> scoredIntervals('scalping') is ['5m'] (1m is retired)
    const scalpingRadio = screen.getByLabelText('Scalping');
    fireEvent.click(scalpingRadio);

    expect(screen.getByLabelText('5m')).toBeInTheDocument();
    expect(screen.queryByLabelText('15m')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('1h')).not.toBeInTheDocument();

    // Switch to Swing trading -> scoredIntervals are ['4h', '1d']
    const swingRadio = screen.getByLabelText('Swing trading');
    fireEvent.click(swingRadio);

    expect(screen.getByLabelText('4h')).toBeInTheDocument();
    expect(screen.getByLabelText('1d')).toBeInTheDocument();
    expect(screen.queryByLabelText('5m')).not.toBeInTheDocument();
  });
});
