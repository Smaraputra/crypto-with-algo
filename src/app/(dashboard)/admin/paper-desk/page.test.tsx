import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRedirect = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ redirect: mockRedirect }));

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth', () => ({ auth: () => mockAuth() }));

vi.mock('@/components/admin-v2', () => ({
  PaperDeskScreen: () => <div data-testid="paper-desk-screen" />,
}));

import PaperDeskPage from '@/app/(dashboard)/admin/paper-desk/page';

describe('/admin/paper-desk page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.ADMIN_EMAIL;
  });

  it('redirects a non-admin away rather than rendering the record', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'someone@example.com' } });

    await PaperDeskPage();

    expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
  });

  it('redirects when ADMIN_EMAIL is unconfigured', async () => {
    delete process.env.ADMIN_EMAIL;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    await PaperDeskPage();

    expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
  });

  it('renders for an admin', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const result = await PaperDeskPage();

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });
});
