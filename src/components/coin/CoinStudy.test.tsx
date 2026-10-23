import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoinStudy } from './CoinStudy';
import { useUIStore } from '@/stores/uiStore';

vi.mock('./CoinChart', () => ({
  CoinChart: () => <div data-testid="mock-coin-chart" />,
}));

vi.mock('./TimeframesPanel', () => ({
  TimeframesPanel: () => <div data-testid="mock-timeframes-panel" />,
}));

vi.mock('./CoinEvidencePanel', () => ({
  CoinEvidencePanel: () => <div data-testid="mock-evidence-panel" />,
}));

vi.mock('./CostPanel', () => ({
  CostPanel: ({ onHoldChange }: { onHoldChange?: (mins: number) => void }) => (
    <div data-testid="mock-cost-panel">
      <button type="button" onClick={() => onHoldChange?.(1440)}>
        Change Hold to 1d
      </button>
    </div>
  ),
}));

vi.mock('./CoinHeadlines', () => ({
  CoinHeadlines: () => <div data-testid="mock-headlines" />,
}));

vi.mock('./StreamHealth', () => ({
  StreamHealth: () => null,
}));

describe('CoinStudy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ selectedSymbol: 'ETHUSDT' });
  });

  it('renders the header title, description, and action links', () => {
    render(<CoinStudy symbol="BTCUSDT" />);

    expect(screen.getByText('BTC study')).toBeInTheDocument();
    expect(screen.getByText('USDT-M perpetual')).toBeInTheDocument();

    const scoreLink = screen.getByRole('link', { name: 'Score detail' });
    expect(scoreLink).toHaveAttribute('href', '/signals');

    const costCheckLink = screen.getByRole('link', { name: 'Open Cost Check' });
    expect(costCheckLink).toHaveAttribute(
      'href',
      '/cost-check?symbol=BTCUSDT&holdMinutes=60'
    );
  });

  it('updates the Cost Check link when the CostPanel chosen hold changes', async () => {
    const user = userEvent.setup();
    render(<CoinStudy symbol="SOLUSDT" />);

    expect(screen.getByText('SOL study')).toBeInTheDocument();
    const costCheckLink = screen.getByRole('link', { name: 'Open Cost Check' });
    expect(costCheckLink).toHaveAttribute(
      'href',
      '/cost-check?symbol=SOLUSDT&holdMinutes=60'
    );

    const changeBtn = screen.getByRole('button', { name: 'Change Hold to 1d' });
    await user.click(changeBtn);

    expect(costCheckLink).toHaveAttribute(
      'href',
      '/cost-check?symbol=SOLUSDT&holdMinutes=1440'
    );
  });

  it('calls setSelectedSymbol when Score detail is clicked and syncs symbol prop', async () => {
    const user = userEvent.setup();
    const setSelectedSpy = vi.spyOn(useUIStore.getState(), 'setSelectedSymbol');

    render(<CoinStudy symbol="BTCUSDT" />);

    expect(setSelectedSpy).toHaveBeenCalledWith('BTCUSDT');

    const scoreLink = screen.getByRole('link', { name: 'Score detail' });
    await user.click(scoreLink);

    expect(setSelectedSpy).toHaveBeenCalledWith('BTCUSDT');
  });

  it('falls back to useUIStore.selectedSymbol when prop is not provided', () => {
    useUIStore.setState({ selectedSymbol: 'AVAXUSDT' });
    render(<CoinStudy />);

    expect(screen.getByText('AVAX study')).toBeInTheDocument();
    const costCheckLink = screen.getByRole('link', { name: 'Open Cost Check' });
    expect(costCheckLink).toHaveAttribute(
      'href',
      '/cost-check?symbol=AVAXUSDT&holdMinutes=60'
    );
  });
});
