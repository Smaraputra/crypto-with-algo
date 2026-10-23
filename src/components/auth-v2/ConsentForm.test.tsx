import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentForm } from './ConsentForm';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

const mockUpdate = vi.fn();
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { id: 'user-1' } },
    update: mockUpdate,
  }),
}));

const mockRecordConsent = vi.fn();
vi.mock('@/lib/auth-forms/flows', () => ({
  recordConsent: (...args: unknown[]) => mockRecordConsent(...args),
}));

describe('ConsentForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps Continue button disabled until checked', async () => {
    const user = userEvent.setup();
    render(<ConsentForm />);

    const continueBtn = screen.getByRole('button', { name: /continue/i });
    expect(continueBtn).toBeDisabled();

    const checkbox = screen.getByRole('checkbox', { name: /terms of service and privacy policy/i });
    await user.click(checkbox);
    expect(continueBtn).not.toBeDisabled();

    await user.click(checkbox);
    expect(continueBtn).toBeDisabled();
  });

  it('calls recordConsent, session update and router.push when checked and submitted', async () => {
    const user = userEvent.setup();
    mockRecordConsent.mockResolvedValueOnce({ ok: true });
    mockUpdate.mockResolvedValueOnce({});

    render(<ConsentForm />);

    const checkbox = screen.getByRole('checkbox', { name: /terms of service and privacy policy/i });
    await user.click(checkbox);

    const continueBtn = screen.getByRole('button', { name: /continue/i });
    await user.click(continueBtn);

    await waitFor(() => {
      expect(mockRecordConsent).toHaveBeenCalledTimes(1);
      expect(mockUpdate).toHaveBeenCalledWith({ tosAccepted: true });
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('displays inline error when recordConsent fails', async () => {
    const user = userEvent.setup();
    mockRecordConsent.mockResolvedValueOnce({
      ok: false,
      message: 'Failed to record consent. Please try again.',
    });

    render(<ConsentForm />);

    const checkbox = screen.getByRole('checkbox', { name: /terms of service and privacy policy/i });
    await user.click(checkbox);

    await user.click(screen.getByRole('button', { name: /continue/i }));

    const errorAlert = await screen.findByRole('alert');
    expect(errorAlert).toHaveTextContent('Failed to record consent. Please try again.');
    expect(mockPush).not.toHaveBeenCalled();
  });
});
