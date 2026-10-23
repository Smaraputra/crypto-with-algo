import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import VerifyEmailPage, { metadata } from './page';

let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

vi.mock('@/lib/auth-forms/flows', () => ({
  verifyEmailToken: vi.fn().mockImplementation(() => new Promise(() => {})),
  resendVerification: vi.fn(),
}));

vi.mock('@/components/auth/turnstile', () => ({
  TurnstileWidget: () => <div data-testid="turnstile-stub" />,
}));

describe('VerifyEmailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it('exports correct metadata titled "Verify email | CryptoWithAlgo"', () => {
    expect(metadata.title).toBe('Verify email | CryptoWithAlgo');
  });

  it('renders AuthShell with title "Verify email" and resend form when no token is present', () => {
    render(<VerifyEmailPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Verify email' })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /send verification email/i })
    ).toBeInTheDocument();
  });

  it('renders verifying state when token is present in searchParams', () => {
    mockSearchParams = new URLSearchParams('token=sample-verify-token');
    render(<VerifyEmailPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Verify email' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /verifying your email/i })).toBeInTheDocument();
  });
});
