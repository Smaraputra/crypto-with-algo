import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ResetPasswordPage, { metadata } from './page';

let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

vi.mock('@/lib/auth-forms/flows', () => ({
  resetPassword: vi.fn(),
}));

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it('exports correct metadata titled "Choose a new password | CryptoWithAlgo"', () => {
    expect(metadata.title).toBe('Choose a new password | CryptoWithAlgo');
  });

  it('renders AuthShell with title "Choose a new password" and invalid link message when no token is present', () => {
    render(<ResetPasswordPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Choose a new password' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /invalid reset link/i })).toBeInTheDocument();
  });

  it('renders form fields when token is present in searchParams', () => {
    mockSearchParams = new URLSearchParams('token=sample-token');
    render(<ResetPasswordPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Choose a new password' })).toBeInTheDocument();
    expect(screen.getByLabelText(/new password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset password/i })).toBeInTheDocument();
  });
});
