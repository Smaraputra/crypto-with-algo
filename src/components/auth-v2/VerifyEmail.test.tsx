import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VerifyEmail } from './VerifyEmail';

let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

const mockVerifyEmailToken = vi.fn();
const mockResendVerification = vi.fn();
vi.mock('@/lib/auth-forms/flows', () => ({
  verifyEmailToken: (...args: unknown[]) => mockVerifyEmailToken(...args),
  resendVerification: (...args: unknown[]) => mockResendVerification(...args),
}));

vi.mock('@/components/auth/turnstile', () => ({
  TurnstileWidget: ({ onToken }: { onToken: (t: string) => void }) => {
    return (
      <button
        type="button"
        data-testid="turnstile-btn"
        onClick={() => onToken('sample-turnstile-token')}
      >
        Turnstile
      </button>
    );
  },
}));

describe('VerifyEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it('calls verifyEmailToken once when a token is provided and shows placeholder while verifying', async () => {
    let resolveVerify: (val: 'success' | 'error') => void = () => {};
    mockVerifyEmailToken.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveVerify = resolve;
        })
    );

    const { rerender } = render(<VerifyEmail token="abc-token-123" />);

    expect(screen.getByRole('heading', { name: /verifying your email/i })).toBeInTheDocument();
    expect(screen.getByTestId('verifying-placeholder')).toBeInTheDocument();
    expect(mockVerifyEmailToken).toHaveBeenCalledTimes(1);
    expect(mockVerifyEmailToken).toHaveBeenCalledWith('abc-token-123');

    // Re-render to simulate React strict mode / re-render
    rerender(<VerifyEmail token="abc-token-123" />);
    expect(mockVerifyEmailToken).toHaveBeenCalledTimes(1);

    resolveVerify('success');
    expect(await screen.findByRole('heading', { name: /email verified/i })).toBeInTheDocument();
  });

  it('shows "Email verified" and "Sign in" link on verification success', async () => {
    mockVerifyEmailToken.mockResolvedValueOnce('success');

    render(<VerifyEmail token="good-token" />);

    expect(await screen.findByRole('heading', { name: /email verified/i })).toBeInTheDocument();
    const signInLink = screen.getByRole('link', { name: /sign in/i });
    expect(signInLink).toBeInTheDocument();
    expect(signInLink).toHaveAttribute('href', '/login');
  });

  it('shows "Verification failed" with message and resend form on verification error', async () => {
    mockVerifyEmailToken.mockResolvedValueOnce('error');

    render(<VerifyEmail token="expired-token" />);

    expect(await screen.findByRole('heading', { name: /verification failed/i })).toBeInTheDocument();
    expect(
      screen.getByText(/this link may have expired\. request a new one below\./i)
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /send verification email/i })
    ).toBeInTheDocument();
  });

  it('disables resend button until widget gives a token, and shows "Check your inbox" after sending', async () => {
    const user = userEvent.setup();
    mockResendVerification.mockResolvedValueOnce({ ok: true });

    render(<VerifyEmail />);

    const submitBtn = screen.getByRole('button', { name: /send verification email/i });
    expect(submitBtn).toBeDisabled();

    // Trigger turnstile token
    await user.click(screen.getByTestId('turnstile-btn'));
    expect(submitBtn).not.toBeDisabled();

    await user.type(screen.getByLabelText(/email/i), 'pending@example.com');
    await user.click(submitBtn);

    await waitFor(() => {
      expect(mockResendVerification).toHaveBeenCalledWith({
        email: 'pending@example.com',
        turnstileToken: 'sample-turnstile-token',
      });
    });

    expect(await screen.findByRole('heading', { name: /check your inbox/i })).toBeInTheDocument();
    expect(
      screen.getByText(/if your account needs verification, an email is on the way\./i)
    ).toBeInTheDocument();
  });
});
