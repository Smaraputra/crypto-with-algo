import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarketingDocsPage, { metadata } from './page';

describe('MarketingDocsPage', () => {
  it('exports honest metadata', () => {
    expect(metadata.title).toBe('Documentation | CryptoWithAlgo');
    expect(metadata.description).toBeDefined();
  });

  it('renders DocsPage with exact h1 and required h2 sections', () => {
    render(<MarketingDocsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Documentation' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Getting started' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Feature reference' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Data and limits' })).toBeInTheDocument();
  });

  it('does not contain banned marketing claims', () => {
    const { container } = render(<MarketingDocsPage />);
    expect(container.textContent).not.toMatch(
      /guarantee|profit|beat the market|predict|accuracy|win rate|tax/i
    );
  });
});
