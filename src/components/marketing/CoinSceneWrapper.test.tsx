import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/dynamic', () => ({
  default: () => {
    const MockCoinScene = () => <div data-testid="coin-scene-dynamic" />;
    MockCoinScene.displayName = 'MockCoinScene';
    return MockCoinScene;
  },
}));

import { CoinSceneWrapper } from './CoinSceneWrapper';

describe('CoinSceneWrapper', () => {
  it('renders section heading', () => {
    render(<CoinSceneWrapper />);
    expect(
      screen.getByRole('heading', { name: 'Next-Generation Technology' })
    ).toBeInTheDocument();
  });

  it('renders description text', () => {
    render(<CoinSceneWrapper />);
    expect(
      screen.getByText(/Built on cutting-edge infrastructure/)
    ).toBeInTheDocument();
  });

  it('renders coin scene container', () => {
    render(<CoinSceneWrapper />);
    expect(screen.getByTestId('coin-scene')).toBeInTheDocument();
  });
});
