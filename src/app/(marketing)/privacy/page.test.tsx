import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarketingPrivacyPage, { metadata } from './page';
import { PRIVACY_LAST_UPDATED } from '@/content/legal/PrivacyContent';

describe('MarketingPrivacyPage', () => {
  it('exports honest metadata', () => {
    expect(metadata.title).toBe('Privacy Policy | CryptoWithAlgo');
    expect(metadata.description).toBeDefined();
  });

  it('renders exact h1 Privacy Policy, last updated date, and PrivacyContent sections', () => {
    render(<MarketingPrivacyPage />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Privacy Policy' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Last updated: ${PRIVACY_LAST_UPDATED}`)
    ).toBeInTheDocument();
    expect(screen.getByText(/1. Introduction/i)).toBeInTheDocument();
    expect(screen.getByText(/2. Information We Collect/i)).toBeInTheDocument();
  });
});
