import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ConsentPage, { metadata } from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { id: 'test-user' } },
    update: vi.fn(),
  }),
}));

vi.mock('@/lib/auth-forms/flows', () => ({
  recordConsent: vi.fn(),
}));

describe('ConsentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports correct metadata titled "Terms | CryptoWithAlgo"', () => {
    expect(metadata.title).toBe('Terms | CryptoWithAlgo');
  });

  it('renders AuthShell with title "Terms", ConsentForm heading, checkbox, and Continue button', () => {
    render(<ConsentPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Terms' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /accept the terms to continue/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /terms of service and privacy policy/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
  });
});
