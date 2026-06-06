import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const searchParams = { get: vi.fn() };
vi.mock('next/navigation', () => ({ useSearchParams: () => searchParams }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/components/auth/turnstile', () => ({
  TurnstileWidget: ({ onToken }: { onToken: (t: string) => void }) => {
    onToken('test-token');
    return <div data-testid="turnstile" />;
  },
}));

import VerifyEmailPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

describe('VerifyEmailPage', () => {
  it('confirms the token on mount and shows success with a sign-in link', async () => {
    searchParams.get.mockReturnValue('tok123');
    render(<VerifyEmailPage />);
    await waitFor(() => expect(screen.getByText(/verified/i)).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/verify-email',
      expect.objectContaining({ method: 'POST' })
    );
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
  });

  it('shows the resend form when no token is present', () => {
    searchParams.get.mockReturnValue(null);
    render(<VerifyEmailPage />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByTestId('turnstile')).toBeInTheDocument();
  });
});
