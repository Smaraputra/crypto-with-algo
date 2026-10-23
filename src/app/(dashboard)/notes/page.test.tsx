import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import NotesPage, { metadata } from './page';

vi.mock('@/components/notes', () => ({
  NotesScreen: () => <div data-testid="notes-screen">Notes Screen Mock</div>,
}));

describe('NotesPage', () => {
  it('has the correct metadata title', () => {
    expect(metadata.title).toBe('Notes | CryptoWithAlgo');
  });

  it('renders NotesScreen inside Suspense', () => {
    render(<NotesPage />);
    expect(screen.getByTestId('notes-screen')).toBeInTheDocument();
  });
});
