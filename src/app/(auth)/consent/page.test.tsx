import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPush = vi.fn();
const mockUpdate = vi.fn();

vi.mock('next-auth/react', () => ({
  useSession: () => ({ update: mockUpdate }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

import ConsentPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = vi.fn();
});

describe('ConsentPage', () => {
  it('renders title and description', () => {
    render(<ConsentPage />);
    expect(screen.getByText('Terms & Privacy')).toBeInTheDocument();
    expect(
      screen.getByText('Please review and accept our terms before continuing')
    ).toBeInTheDocument();
  });

  it('renders ToS and Privacy Policy links', () => {
    render(<ConsentPage />);
    const tosLink = screen.getByRole('link', { name: 'Terms of Service' });
    const ppLink = screen.getByRole('link', { name: 'Privacy Policy' });
    expect(tosLink).toHaveAttribute('href', '/terms');
    expect(ppLink).toHaveAttribute('href', '/privacy');
  });

  it('renders checkbox and continue button', () => {
    render(<ConsentPage />);
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  it('disables continue button when checkbox is unchecked', () => {
    render(<ConsentPage />);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('enables continue button when checkbox is checked', async () => {
    const user = userEvent.setup();
    render(<ConsentPage />);

    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('calls consent API and redirects on success', async () => {
    const user = userEvent.setup();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );
    mockUpdate.mockResolvedValue({});

    render(<ConsentPage />);

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/auth/consent', {
        method: 'POST',
      });
    });

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('shows error on API failure', async () => {
    const user = userEvent.setup();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    );

    render(<ConsentPage />);

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Unauthorized');
    });
  });

  it('shows error on network failure', async () => {
    const user = userEvent.setup();
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('Network error'));

    render(<ConsentPage />);

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Network error. Please try again.'
      );
    });
  });
});
