import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginForm } from './LoginForm';

const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
  useSearchParams: () => mockSearchParams,
}));

const mockSignIn = vi.fn();
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => mockSignIn(...args),
}));

const mockLoginWithCredentials = vi.fn();
vi.mock('@/lib/auth-forms/flows', () => ({
  loginWithCredentials: (...args: unknown[]) => mockLoginWithCredentials(...args),
}));

describe('LoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it('renders fields labelled exactly "Email" and "Password" and buttons named "Sign in", "Google", "GitHub"', () => {
    render(<LoginForm />);

    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    const forgotLink = screen.getByRole('link', { name: 'Forgot password?' });
    expect(forgotLink).toBeInTheDocument();
    expect(forgotLink).toHaveAttribute('href', '/forgot-password');
    expect(forgotLink).toHaveClass('min-h-[44px]');
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'GitHub' })).toBeInTheDocument();
  });

  it('calls loginWithCredentials and pushes the safe callback on success', async () => {
    const user = userEvent.setup();
    mockSearchParams = new URLSearchParams('callbackUrl=/portfolio');
    mockLoginWithCredentials.mockResolvedValueOnce({ ok: true });

    render(<LoginForm />);

    await user.type(screen.getByLabelText('Email'), 'trader@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(mockLoginWithCredentials).toHaveBeenCalledWith({
        email: 'trader@example.com',
        password: 'password123',
      });
      expect(mockPush).toHaveBeenCalledWith('/portfolio');
    });
  });

  it('shows "Invalid email or password" on credential failure', async () => {
    const user = userEvent.setup();
    mockLoginWithCredentials.mockResolvedValueOnce({
      ok: false,
      message: 'Invalid email or password',
    });

    render(<LoginForm />);

    await user.type(screen.getByLabelText('Email'), 'trader@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrongpassword');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const errorAlert = await screen.findByRole('alert');
    expect(errorAlert).toHaveTextContent('Invalid email or password');
  });

  it('shows the unverified message containing "verify your email" and verification link for needsVerification', async () => {
    const user = userEvent.setup();
    mockLoginWithCredentials.mockResolvedValueOnce({
      ok: false,
      message: 'Please verify your email before signing in.',
      needsVerification: true,
    });

    render(<LoginForm />);

    await user.type(screen.getByLabelText('Email'), 'unverified@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alertBox = await screen.findByRole('alert');
    expect(alertBox).toHaveTextContent(/verify your email/i);

    const verifyLink = screen.getByRole('link', { name: 'Send a new verification email' });
    expect(verifyLink).toBeInTheDocument();
    expect(verifyLink).toHaveAttribute('href', '/verify-email');
  });

  it('passes the safe callback to Google and GitHub OAuth buttons', async () => {
    const user = userEvent.setup();
    mockSearchParams = new URLSearchParams('callbackUrl=/alerts');

    render(<LoginForm />);

    await user.click(screen.getByRole('button', { name: 'Google' }));
    expect(mockSignIn).toHaveBeenCalledWith('google', { callbackUrl: '/alerts' });

    await user.click(screen.getByRole('button', { name: 'GitHub' }));
    expect(mockSignIn).toHaveBeenCalledWith('github', { callbackUrl: '/alerts' });
  });

  it('sanitizes unsafe callback URLs like https://evil.example to /dashboard', async () => {
    const user = userEvent.setup();
    mockSearchParams = new URLSearchParams('callbackUrl=https://evil.example');
    mockLoginWithCredentials.mockResolvedValueOnce({ ok: true });

    render(<LoginForm />);

    await user.type(screen.getByLabelText('Email'), 'trader@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });

    await user.click(screen.getByRole('button', { name: 'Google' }));
    expect(mockSignIn).toHaveBeenCalledWith('google', { callbackUrl: '/dashboard' });
  });
});
