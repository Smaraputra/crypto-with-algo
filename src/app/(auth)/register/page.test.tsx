import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RegisterPage, { metadata } from './page';

vi.mock('next-auth/react', () => ({
  signIn: vi.fn(),
}));

vi.mock('@/lib/auth-forms/flows', () => ({
  registerAccount: vi.fn(),
}));

vi.mock('@/components/auth/turnstile', () => ({
  TurnstileWidget: () => <div data-testid="turnstile-stub" />,
}));

describe('RegisterPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports correct metadata titled "Create account | CryptoWithAlgo"', () => {
    expect(metadata.title).toBe('Create account | CryptoWithAlgo');
  });

  it('renders AuthShell with title "Create account", form fields, and exactly one checkbox', () => {
    render(<RegisterPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Create account' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm/i)).toBeInTheDocument();

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(1);
    expect(checkboxes[0]).toHaveAccessibleName(/terms of service and privacy policy/i);

    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  });
});
