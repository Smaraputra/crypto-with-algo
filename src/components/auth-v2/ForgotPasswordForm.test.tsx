import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForgotPasswordForm } from './ForgotPasswordForm';

const mockRequestPasswordReset = vi.fn();
vi.mock('@/lib/auth-forms/flows', () => ({
  requestPasswordReset: (...args: unknown[]) => mockRequestPasswordReset(...args),
}));

vi.mock('@/components/auth/turnstile', () => ({
  TurnstileWidget: ({ onToken }: { onToken: (t: string) => void }) => {
    return <button type="button" onClick={() => onToken('test-turnstile-token')}>Turnstile</button>;
  },
}));

describe('ForgotPasswordForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a field whose label contains "Email" and button whose name contains "Send reset link"', () => {
    render(<ForgotPasswordForm />);

    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
  });

  it('renders neutral confirmation after submit containing "If an account exists"', async () => {
    const user = userEvent.setup();
    mockRequestPasswordReset.mockResolvedValueOnce({ ok: true });

    render(<ForgotPasswordForm />);

    await user.type(screen.getByLabelText(/email/i), 'user@example.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => {
      expect(mockRequestPasswordReset).toHaveBeenCalledWith({
        email: 'user@example.com',
        turnstileToken: '',
      });
    });

    expect(await screen.findByRole('heading', { name: /check your inbox/i })).toBeInTheDocument();
    expect(screen.getByText(/if an account exists/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to sign in/i })).toHaveAttribute('href', '/login');
  });

  it('renders neutral confirmation even when the request fails', async () => {
    const user = userEvent.setup();
    mockRequestPasswordReset.mockRejectedValueOnce(new Error('Network failure'));

    render(<ForgotPasswordForm />);

    await user.type(screen.getByLabelText(/email/i), 'user@example.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => {
      expect(mockRequestPasswordReset).toHaveBeenCalled();
    });

    expect(await screen.findByRole('heading', { name: /check your inbox/i })).toBeInTheDocument();
    expect(screen.getByText(/if an account exists/i)).toBeInTheDocument();
  });
});
