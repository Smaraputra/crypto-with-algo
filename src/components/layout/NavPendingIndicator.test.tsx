import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockStatus = { pending: false };

vi.mock('next/link', () => ({
  useLinkStatus: () => mockStatus,
}));

import { NavPendingIndicator } from './NavPendingIndicator';

describe('NavPendingIndicator', () => {
  beforeEach(() => {
    mockStatus = { pending: false };
  });

  it('is not pending when navigation is idle', () => {
    render(<NavPendingIndicator />);
    const indicator = screen.getByTestId('nav-pending-indicator');
    expect(indicator).toHaveAttribute('data-pending', 'false');
    expect(indicator).toHaveAttribute('aria-hidden', 'true');
  });

  it('is pending while its link navigation is in flight', () => {
    mockStatus = { pending: true };
    render(<NavPendingIndicator />);
    const indicator = screen.getByTestId('nav-pending-indicator');
    expect(indicator).toHaveAttribute('data-pending', 'true');
  });
});
