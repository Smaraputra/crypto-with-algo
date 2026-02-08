import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockPathname = '/';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

let mockSidebarOpen = true;
let mockMobileSidebarOpen = false;
const mockSetMobileSidebarOpen = vi.fn();

vi.mock('@/stores/uiStore', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      sidebarOpen: mockSidebarOpen,
      mobileSidebarOpen: mockMobileSidebarOpen,
      setMobileSidebarOpen: mockSetMobileSidebarOpen,
    }),
}));

import { Sidebar } from './Sidebar';

beforeEach(() => {
  vi.clearAllMocks();
  mockPathname = '/';
  mockSidebarOpen = true;
  mockMobileSidebarOpen = false;
});

describe('Sidebar', () => {
  it('renders Dashboard nav item linking to /', () => {
    render(<Sidebar />);
    const links = screen.getAllByText('Dashboard');
    const dashboardLink = links.find((el) => el.closest('a'));
    expect(dashboardLink?.closest('a')).toHaveAttribute('href', '/');
  });

  it('renders Portfolio item with Soon badge', () => {
    render(<Sidebar />);
    expect(screen.getAllByText('Portfolio').length).toBeGreaterThan(0);
    const soonBadges = screen.getAllByText('Soon');
    expect(soonBadges.length).toBeGreaterThanOrEqual(2); // desktop + mobile
  });

  it('renders Alerts item with Soon badge', () => {
    render(<Sidebar />);
    expect(screen.getAllByText('Alerts').length).toBeGreaterThan(0);
  });

  it('highlights active item when pathname matches', () => {
    mockPathname = '/';
    render(<Sidebar />);
    const dashboardLinks = screen.getAllByText('Dashboard');
    const link = dashboardLinks.find((el) => el.closest('a'))?.closest('a');
    expect(link?.className).toContain('bg-sidebar-accent');
  });

  it('does not highlight non-matching items', () => {
    mockPathname = '/other';
    render(<Sidebar />);
    const dashboardLinks = screen.getAllByText('Dashboard');
    const link = dashboardLinks.find((el) => el.closest('a'))?.closest('a');
    expect(link?.className).toContain('text-sidebar-foreground');
    expect(link?.className).not.toContain('text-sidebar-accent-foreground');
  });

  it('applies disabled styles to disabled items', () => {
    render(<Sidebar />);
    const portfolioLinks = screen.getAllByText('Portfolio');
    const link = portfolioLinks.find((el) => el.closest('a'))?.closest('a');
    expect(link?.className).toContain('pointer-events-none');
    expect(link?.className).toContain('opacity-40');
  });

  it('renders desktop sidebar with w-56 when sidebarOpen is true', () => {
    mockSidebarOpen = true;
    render(<Sidebar />);
    const aside = screen.getByTestId('desktop-sidebar');
    expect(aside.className).toContain('w-56');
    expect(aside.className).not.toContain('w-0');
  });

  it('renders desktop sidebar with w-0 when sidebarOpen is false', () => {
    mockSidebarOpen = false;
    render(<Sidebar />);
    const aside = screen.getByTestId('desktop-sidebar');
    expect(aside.className).toContain('w-0');
    expect(aside.className).not.toContain('w-56');
  });

  it('renders sidebar header with app name', () => {
    render(<Sidebar />);
    const headers = screen.getAllByText('Crypto Tracker');
    expect(headers.length).toBeGreaterThan(0);
  });
});
