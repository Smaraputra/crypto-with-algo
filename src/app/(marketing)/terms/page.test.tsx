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

import TermsPage from './page';

describe('TermsPage', () => {
  it('renders terms of service heading', () => {
    render(<TermsPage />);
    expect(screen.getByRole('heading', { name: 'Terms of Service' })).toBeInTheDocument();
  });

  it('renders last updated date', () => {
    render(<TermsPage />);
    expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
  });

  it('renders placeholder content', () => {
    render(<TermsPage />);
    expect(screen.getByText(/Terms of service content to be added/)).toBeInTheDocument();
  });
});
