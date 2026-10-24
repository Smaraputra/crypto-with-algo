import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarketingFeaturesPage, { metadata } from './page';

describe('MarketingFeaturesPage', () => {
  it('exports honest metadata', () => {
    expect(metadata.title).toBe('Features | CryptoWithAlgo');
    expect(metadata.description).toBeDefined();
  });

  it('renders FeaturesPage with exact h1 and required h2 groups', () => {
    render(<MarketingFeaturesPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Features' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Market and coins' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Research' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Your trades' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Tools' })).toBeInTheDocument();
  });

  it('does not contain banned marketing claims', () => {
    const { container } = render(<MarketingFeaturesPage />);
    expect(container.textContent).not.toMatch(
      /guarantee|profit|beat the market|predict|accuracy|win rate|tax/i
    );
  });
});
