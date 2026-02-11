import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResearchNoteCard } from './ResearchNoteCard';
import type { ResearchNote } from '@/types/research-note';

const mockNote: ResearchNote = {
  _id: 'rn-1',
  userId: 'user-1',
  title: 'BTC breakout strategy',
  content: '## Entry Criteria',
  category: 'strategy',
  tags: ['breakout', 'btc', 'momentum'],
  relatedSymbols: ['BTCUSDT'],
  isPinned: false,
  createdAt: '2025-01-10T00:00:00.000Z',
  updatedAt: '2025-01-10T00:00:00.000Z',
};

describe('ResearchNoteCard', () => {
  it('renders note title', () => {
    render(<ResearchNoteCard note={mockNote} isSelected={false} onClick={vi.fn()} />);
    expect(screen.getByText('BTC breakout strategy')).toBeInTheDocument();
  });

  it('renders category badge', () => {
    render(<ResearchNoteCard note={mockNote} isSelected={false} onClick={vi.fn()} />);
    expect(screen.getByText('Strategy')).toBeInTheDocument();
  });

  it('renders first two tags with overflow count', () => {
    render(<ResearchNoteCard note={mockNote} isSelected={false} onClick={vi.fn()} />);
    expect(screen.getByText('breakout')).toBeInTheDocument();
    expect(screen.getByText('btc')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
  });

  it('shows pin icon when pinned', () => {
    const pinned = { ...mockNote, isPinned: true };
    render(<ResearchNoteCard note={pinned} isSelected={false} onClick={vi.fn()} />);
    expect(screen.getByTestId('pin-icon')).toBeInTheDocument();
  });

  it('does not show pin icon when not pinned', () => {
    render(<ResearchNoteCard note={mockNote} isSelected={false} onClick={vi.fn()} />);
    expect(screen.queryByTestId('pin-icon')).not.toBeInTheDocument();
  });

  it('applies selected styling', () => {
    render(<ResearchNoteCard note={mockNote} isSelected={true} onClick={vi.fn()} />);
    const button = screen.getByTestId('research-note-card-rn-1');
    expect(button.className).toContain('border-primary');
  });

  it('calls onClick when clicked', async () => {
    const onClick = vi.fn();
    render(<ResearchNoteCard note={mockNote} isSelected={false} onClick={onClick} />);
    screen.getByTestId('research-note-card-rn-1').click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
