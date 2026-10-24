import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BlogPage } from './BlogPage';

describe('BlogPage', () => {
  it('renders exact h1 Blog and honest empty state h2 No posts yet', () => {
    render(<BlogPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Blog' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'No posts yet' })).toBeInTheDocument();
    expect(
      screen.getByText('Nothing has been published here yet.')
    ).toBeInTheDocument();
  });

  it('does not contain banned marketing claims', () => {
    const { container } = render(<BlogPage />);
    expect(container.textContent).not.toMatch(
      /guarantee|profit|beat the market|predict|accuracy|win rate|tax/i
    );
    expect(container.textContent).not.toMatch(
      /public record|public research lab|public ledger|markdown|survivorship|instant|currently validated|volume delta|frozen/i
    );
  });
});
