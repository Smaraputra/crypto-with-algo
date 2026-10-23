import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResetPasswordForm } from './ResetPasswordForm';

let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

const mockResetPassword = vi.fn();
vi.mock('@/lib/auth-forms/flows', () => ({
  resetPassword: (...args: unknown[]) => mockResetPassword(...args),
}));

describe('ResetPasswordForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it('renders the invalid-link state with request link when no token is present', () => {
    render(<ResetPasswordForm />);

    expect(screen.getByRole('heading', { name: /invalid reset link/i })).toBeInTheDocument();
    const requestLink = screen.getByRole('link', { name: /request a new reset link/i });
    expect(requestLink).toBeInTheDocument();
    expect(requestLink).toHaveAttribute('href', '/forgot-password');
  });

  it('shows the server message on failure', async () => {
    const user = userEvent.setup();
    mockSearchParams = new URLSearchParams('token=sample-reset-token');
    mockResetPassword.mockResolvedValueOnce({
      ok: false,
      message: 'Token has expired or is invalid.',
    });

    render(<ResetPasswordForm />);

    expect(screen.getByLabelText(/new password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/new password/i), 'NewPassword123!');
    await user.type(screen.getByLabelText(/confirm password/i), 'NewPassword123!');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    const errorAlert = await screen.findByRole('alert');
    expect(errorAlert).toHaveTextContent('Token has expired or is invalid.');
  });

  it('renders the success state with sign-in link on successful reset', async () => {
    const user = userEvent.setup();
    mockResetPassword.mockResolvedValueOnce({ ok: true });

    render(<ResetPasswordForm token="valid-token-123" />);

    await user.type(screen.getByLabelText(/new password/i), 'NewPassword123!');
    await user.type(screen.getByLabelText(/confirm password/i), 'NewPassword123!');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    await waitFor(() => {
      expect(mockResetPassword).toHaveBeenCalledWith({
        token: 'valid-token-123',
        password: 'NewPassword123!',
        confirm: 'NewPassword123!',
      });
    });

    expect(await screen.findByRole('heading', { name: /password reset/i })).toBeInTheDocument();
    const signInLink = screen.getByRole('link', { name: /sign in/i });
    expect(signInLink).toBeInTheDocument();
    expect(signInLink).toHaveAttribute('href', '/login');
  });
});
