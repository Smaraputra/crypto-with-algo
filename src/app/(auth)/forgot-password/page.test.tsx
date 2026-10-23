import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ForgotPasswordPage, { metadata } from './page';

vi.mock('@/lib/auth-forms/flows', () => ({
  requestPasswordReset: vi.fn(),
}));

vi.mock('@/components/auth/turnstile', () => ({
  TurnstileWidget: () => <div data-testid="turnstile-stub" />,
}));

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports correct metadata titled "Reset password | CryptoWithAlgo"', () => {
    expect(metadata.title).toBe('Reset password | CryptoWithAlgo');
  });

  it('renders AuthShell with title "Reset password", Email input, and "Send reset link" button', () => {
    render(<ForgotPasswordPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Reset password' })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
  });
});
