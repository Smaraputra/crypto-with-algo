import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/dynamic', () => ({
  default: () => {
    const MockGlobeScene = () => <div data-testid="globe-scene-dynamic" />;
    MockGlobeScene.displayName = 'MockGlobeScene';
    return MockGlobeScene;
  },
}));

import { CoinSceneWrapper } from './CoinSceneWrapper';

describe('CoinSceneWrapper', () => {
  it('renders section heading', () => {
    render(<CoinSceneWrapper />);
    expect(
      screen.getByRole('heading', { name: 'Global Algorithmic Network' })
    ).toBeInTheDocument();
  });

  it('renders description text', () => {
    render(<CoinSceneWrapper />);
    expect(
      screen.getByText(/Distributed infrastructure/)
    ).toBeInTheDocument();
  });

  it('renders scene container', () => {
    render(<CoinSceneWrapper />);
    expect(screen.getByTestId('coin-scene')).toBeInTheDocument();
  });
});
