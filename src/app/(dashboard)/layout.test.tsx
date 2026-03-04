// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.fn();
const mockRedirect = vi.fn();

vi.mock('@/lib/auth', () => ({
  auth: () => mockAuth(),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    mockRedirect(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

vi.mock('@/components/layout/Sidebar', () => ({
  Sidebar: () => null,
}));

vi.mock('@/components/layout/Header', () => ({
  Header: () => null,
}));

import DashboardLayout from './layout';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DashboardLayout consent gate', () => {
  it('redirects to /consent when tosAccepted is false', async () => {
    mockAuth.mockResolvedValue({
      user: { id: 'user-123', tosAccepted: false },
    });

    await expect(
      DashboardLayout({ children: null })
    ).rejects.toThrow('NEXT_REDIRECT:/consent');

    expect(mockRedirect).toHaveBeenCalledWith('/consent');
  });

  it('does not redirect when tosAccepted is true', async () => {
    mockAuth.mockResolvedValue({
      user: { id: 'user-123', tosAccepted: true },
    });

    const result = await DashboardLayout({ children: null });
    expect(result).toBeDefined();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('does not redirect when session is null', async () => {
    mockAuth.mockResolvedValue(null);

    const result = await DashboardLayout({ children: null });
    expect(result).toBeDefined();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
