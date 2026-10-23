import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SignalsPage, { metadata } from './page';

vi.mock('@/components/score', () => ({
  ScorePage: () => <div data-testid="score-page-root">Score Page Root</div>,
}));

describe('SignalsPage', () => {
  it('defines metadata with the title "Price score | CryptoWithAlgo"', () => {
    expect(metadata.title).toBe('Price score | CryptoWithAlgo');
  });

  it('renders the ScorePage component', () => {
    render(<SignalsPage />);
    expect(screen.getByTestId('score-page-root')).toBeInTheDocument();
  });
});
