import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarketingTermsPage, { metadata } from './page';
import { TERMS_LAST_UPDATED } from '@/content/legal/TermsContent';

describe('MarketingTermsPage', () => {
  it('exports honest metadata', () => {
    expect(metadata.title).toBe('Terms of Service | CryptoWithAlgo');
    expect(metadata.description).toBeDefined();
  });

  it('renders exact h1 Terms of Service, last updated date, and TermsContent sections', () => {
    render(<MarketingTermsPage />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Terms of Service' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Last updated: ${TERMS_LAST_UPDATED}`)
    ).toBeInTheDocument();
    expect(screen.getByText(/1. Acceptance of Terms/i)).toBeInTheDocument();
    expect(screen.getByText(/2. Description of Service/i)).toBeInTheDocument();
  });
});
