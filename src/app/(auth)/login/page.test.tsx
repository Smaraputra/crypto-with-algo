import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage, { metadata } from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next-auth/react', () => ({
  signIn: vi.fn(),
}));

vi.mock('@/lib/auth-forms/flows', () => ({
  loginWithCredentials: vi.fn(),
}));

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports correct metadata titled "Sign in | CryptoWithAlgo"', () => {
    expect(metadata.title).toBe('Sign in | CryptoWithAlgo');
  });

  it('renders AuthShell with title "Sign in" and LoginForm fields', () => {
    render(<LoginPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });
});
