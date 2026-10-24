import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from 'next-auth/react';
import { SessionCta } from './SessionCta';

vi.mock('next-auth/react', () => ({
  useSession: vi.fn(),
}));

function mockStatus(status: 'authenticated' | 'unauthenticated' | 'loading') {
  vi.mocked(useSession).mockReturnValue({
    data: status === 'authenticated' ? { user: { name: 'Ada' }, expires: '' } : null,
    status,
    update: vi.fn(),
  } as unknown as ReturnType<typeof useSession>);
}

describe('SessionCta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a signed-in visitor to the dashboard', () => {
    mockStatus('authenticated');
    render(<SessionCta />);
    expect(screen.getByRole('link', { name: 'Open dashboard' })).toHaveAttribute('href', '/dashboard');
    expect(screen.queryByText('Create a free account')).not.toBeInTheDocument();
  });

  it('offers a signed-out visitor a free account', () => {
    mockStatus('unauthenticated');
    render(<SessionCta className="cta" />);
    const link = screen.getByRole('link', { name: 'Create a free account' });
    expect(link).toHaveAttribute('href', '/register');
    expect(link).toHaveClass('cta');
    expect(link).not.toHaveClass('invisible');
  });

  it('holds its space unseen and out of the tab order while the session loads', () => {
    mockStatus('loading');
    render(<SessionCta />);
    const link = screen.getByText('Create a free account');
    expect(link).toHaveClass('invisible');
    expect(link).toHaveAttribute('aria-hidden', 'true');
    expect(link).toHaveAttribute('tabindex', '-1');
  });
});
