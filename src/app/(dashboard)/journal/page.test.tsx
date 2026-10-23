import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import JournalPage, { metadata } from './page';

vi.mock('@/components/journal-v2', () => ({
  JournalScreen: () => <div data-testid="journal-screen">Journal Screen Mock</div>,
}));

describe('JournalPage', () => {
  it('has the correct metadata title', () => {
    expect(metadata.title).toBe('Journal | CryptoWithAlgo');
  });

  it('renders JournalScreen inside Suspense', () => {
    render(<JournalPage />);
    expect(screen.getByTestId('journal-screen')).toBeInTheDocument();
  });
});
