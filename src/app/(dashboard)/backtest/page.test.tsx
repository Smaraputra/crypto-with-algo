import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BacktestPage, { metadata } from './page';

vi.mock('@/components/backtest-v2', () => ({
  BacktestScreen: () => <div data-testid="backtest-screen">Backtest Screen</div>,
}));

describe('BacktestPage', () => {
  it('renders the BacktestScreen component', () => {
    render(<BacktestPage />);
    expect(screen.getByTestId('backtest-screen')).toBeInTheDocument();
  });

  it('declares the page metadata title', () => {
    expect(metadata.title).toBe('Backtest | CryptoWithAlgo');
  });
});
