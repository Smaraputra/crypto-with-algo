import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/components/auth/turnstile', () => ({
  TurnstileWidget: ({ onToken }: { onToken: (t: string) => void }) => {
    onToken('test-token');
    return <div data-testid="turnstile" />;
  },
}));

import ForgotPasswordPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

describe('ForgotPasswordPage', () => {
  it('renders the email input and turnstile widget', () => {
    render(<ForgotPasswordPage />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByTestId('turnstile')).toBeInTheDocument();
  });

  it('submits to forgot-password and shows a neutral confirmation', async () => {
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/auth/forgot-password',
        expect.objectContaining({ method: 'POST' })
      )
    );
    expect(screen.getByText(/if an account exists/i)).toBeInTheDocument();
  });
});
