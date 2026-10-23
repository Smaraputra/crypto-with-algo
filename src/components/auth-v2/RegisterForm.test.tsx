import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RegisterForm } from './RegisterForm';

const mockSignIn = vi.fn();
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => mockSignIn(...args),
}));

const mockRegisterAccount = vi.fn();
vi.mock('@/lib/auth-forms/flows', () => ({
  registerAccount: (...args: unknown[]) => mockRegisterAccount(...args),
}));

vi.mock('@/components/auth/turnstile', () => ({
  TurnstileWidget: ({ onToken }: { onToken: (t: string) => void }) => {
    return <button type="button" onClick={() => onToken('test-token')}>Turnstile</button>;
  },
}));

describe('RegisterForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders fields labelled "Name", "Email", "Password", a label containing "Confirm", exactly one checkbox, and "Create account" button', () => {
    render(<RegisterForm />);

    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm/i)).toBeInTheDocument();

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(1);
    expect(checkboxes[0]).toHaveAccessibleName(/terms of service and privacy policy/i);

    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'GitHub' })).toBeInTheDocument();
  });

  it('shows schema error inline when the passwords differ', async () => {
    const user = userEvent.setup();
    render(<RegisterForm />);

    await user.type(screen.getByLabelText('Name'), 'Alice Trader');
    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'Password123!');
    await user.type(screen.getByLabelText(/confirm/i), 'DifferentPassword123!');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /create account/i }));

    const errorAlert = await screen.findByText('Passwords do not match');
    expect(errorAlert).toBeInTheDocument();
    expect(errorAlert).toHaveAttribute('role', 'alert');
    expect(mockRegisterAccount).not.toHaveBeenCalled();
  });

  it('renders success text containing "Check your inbox" after successful registration', async () => {
    const user = userEvent.setup();
    mockRegisterAccount.mockResolvedValueOnce({ ok: true });

    render(<RegisterForm />);

    await user.type(screen.getByLabelText('Name'), 'Alice Trader');
    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'Password123!');
    await user.type(screen.getByLabelText(/confirm/i), 'Password123!');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(mockRegisterAccount).toHaveBeenCalledWith({
        name: 'Alice Trader',
        email: 'alice@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
        tosAccepted: true,
        turnstileToken: '',
      });
    });

    expect(await screen.findByRole('heading', { name: /check your inbox/i })).toBeInTheDocument();
    expect(
      screen.getByText(/we sent a verification link to alice@example\.com\. open it to activate your account\./i)
    ).toBeInTheDocument();
  });

  it('passes /dashboard to OAuth buttons', async () => {
    const user = userEvent.setup();
    render(<RegisterForm />);

    await user.click(screen.getByRole('button', { name: 'Google' }));
    expect(mockSignIn).toHaveBeenCalledWith('google', { callbackUrl: '/dashboard' });

    await user.click(screen.getByRole('button', { name: 'GitHub' }));
    expect(mockSignIn).toHaveBeenCalledWith('github', { callbackUrl: '/dashboard' });
  });
});
