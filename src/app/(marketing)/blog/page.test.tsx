import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarketingBlogPage, { metadata } from './page';

describe('MarketingBlogPage', () => {
  it('exports honest metadata', () => {
    expect(metadata.title).toBe('Blog | CryptoWithAlgo');
    expect(metadata.description).toBeDefined();
  });

  it('renders exact h1 Blog and honest empty state h2 No posts yet', () => {
    render(<MarketingBlogPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Blog' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'No posts yet' })).toBeInTheDocument();
  });

  it('does not contain banned marketing claims', () => {
    const { container } = render(<MarketingBlogPage />);
    expect(container.textContent).not.toMatch(
      /guarantee|profit|beat the market|predict|accuracy|win rate|tax/i
    );
  });
});
