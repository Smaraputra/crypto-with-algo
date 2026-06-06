import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/auth/turnstile', () => ({
  TurnstileWidget: ({ onToken }: { onToken: (t: string) => void }) => {
    onToken('test-token');
    return <div data-testid="turnstile" />;
  },
}));

import RegisterPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

describe('RegisterPage', () => {
  it('renders the form with name, email, password, confirm, ToS, and Turnstile', () => {
    render(<RegisterPage />);
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByTestId('turnstile')).toBeInTheDocument();
  });

  it('shows the check-inbox screen after successful submit', async () => {
    render(<RegisterPage />);
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Ada Lovelace' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'ada@test.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Secret1!' } });
    fireEvent.change(screen.getByLabelText(/confirm/i), { target: { value: 'Secret1!' } });
    fireEvent.click(screen.getByLabelText(/terms/i));
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => expect(screen.getByText(/check your inbox/i)).toBeInTheDocument());
  });
});
