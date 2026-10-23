import { render, screen } from '@testing-library/react';
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

vi.mock('@/components/shell', () => ({
  AppShell: () => <div data-testid="app-shell">AppShellMock</div>,
}));

import DashboardLayout from './layout';

describe('DashboardLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('consent gate', () => {
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

  describe('structure', () => {
    it('renders the shell, skip link and main#main-content', async () => {
      mockAuth.mockResolvedValue({
        user: { id: 'user-123', tosAccepted: true },
      });

      const jsx = await DashboardLayout({
        children: <div data-testid="child-content">Child Content</div>,
      });

      render(jsx);

      // Skip link
      const skipLink = screen.getByRole('link', { name: 'Skip to content' });
      expect(skipLink).toBeInTheDocument();
      expect(skipLink).toHaveAttribute('href', '#main-content');

      // Shell renders
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();

      // main#main-content exists and has children
      const main = document.getElementById('main-content');
      expect(main).toBeInTheDocument();
      expect(main?.tagName.toLowerCase()).toBe('main');
      expect(main).toHaveAttribute('tabindex', '-1');
      expect(main).toHaveClass('outline-none');
      expect(screen.getByTestId('child-content')).toBeInTheDocument();
    });
  });
});
