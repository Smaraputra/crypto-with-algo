import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/marketing/ContentLayout', () => ({
  ContentLayout: ({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      <div>{children}</div>
    </div>
  ),
}));

import PrivacyPage from './page';

describe('PrivacyPage', () => {
  it('renders privacy policy heading', () => {
    render(<PrivacyPage />);
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
  });

  it('renders last updated date', () => {
    render(<PrivacyPage />);
    expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
  });

  it('renders introduction section', () => {
    render(<PrivacyPage />);
    expect(screen.getByText(/CryptoWithAlgo.*is committed to protecting your privacy/)).toBeInTheDocument();
  });
});
