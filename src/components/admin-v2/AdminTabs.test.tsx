import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { AdminTabs } from './AdminTabs';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/calibration',
}));

describe('AdminTabs', () => {
  it('marks the current page with aria-current="page"', () => {
    render(<AdminTabs currentPath="/admin/calibration" />);

    const calibrationLink = screen.getByRole('link', { name: 'Calibration' });
    const paperDeskLink = screen.getByRole('link', { name: 'Paper desk' });

    expect(calibrationLink).toHaveAttribute('aria-current', 'page');
    expect(calibrationLink).toHaveClass('bg-foreground');
    expect(calibrationLink).toHaveClass('text-background');

    expect(paperDeskLink).not.toHaveAttribute('aria-current');
  });

  it('marks paper desk when currentPath is /admin/paper-desk', () => {
    render(<AdminTabs currentPath="/admin/paper-desk" />);

    const calibrationLink = screen.getByRole('link', { name: 'Calibration' });
    const paperDeskLink = screen.getByRole('link', { name: 'Paper desk' });

    expect(paperDeskLink).toHaveAttribute('aria-current', 'page');
    expect(calibrationLink).not.toHaveAttribute('aria-current');
  });

  it('renders both navigation links with correct destinations', () => {
    render(<AdminTabs currentPath="/admin/calibration" />);

    expect(screen.getByRole('link', { name: 'Calibration' })).toHaveAttribute('href', '/admin/calibration');
    expect(screen.getByRole('link', { name: 'Paper desk' })).toHaveAttribute('href', '/admin/paper-desk');
  });
});
