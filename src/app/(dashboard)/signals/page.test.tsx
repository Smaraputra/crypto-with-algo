import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SignalsPage, { metadata } from './page';

vi.mock('@/components/signals-hub', () => ({
  ResearchHub: () => <div data-testid="research-hub-root">Research Hub Root</div>,
}));

describe('SignalsPage', () => {
  it('defines metadata with the title "Signals and research | CryptoWithAlgo"', () => {
    expect(metadata.title).toBe('Signals and research | CryptoWithAlgo');
  });

  it('renders the ResearchHub component', () => {
    render(<SignalsPage />);
    expect(screen.getByTestId('research-hub-root')).toBeInTheDocument();
  });
});
