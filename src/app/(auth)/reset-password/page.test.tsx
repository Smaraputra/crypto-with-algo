import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const searchParams = { get: vi.fn() };
vi.mock('next/navigation', () => ({ useSearchParams: () => searchParams }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

import ResetPasswordPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

describe('ResetPasswordPage', () => {
  it('submits the new password with the token and shows success', async () => {
    searchParams.get.mockReturnValue('tok123');
    render(<ResetPasswordPage />);
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'Secret1!' } });
    fireEvent.change(screen.getByLabelText(/confirm/i), { target: { value: 'Secret1!' } });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/auth/reset-password',
        expect.objectContaining({ method: 'POST' })
      )
    );
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
  });

  it('shows a mismatch error without calling fetch', async () => {
    searchParams.get.mockReturnValue('tok123');
    render(<ResetPasswordPage />);
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'Secret1!' } });
    fireEvent.change(screen.getByLabelText(/confirm/i), { target: { value: 'Different1!' } });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));
    await waitFor(() => expect(screen.getByText(/do not match/i)).toBeInTheDocument());
    expect(fetch).not.toHaveBeenCalled();
  });
});
