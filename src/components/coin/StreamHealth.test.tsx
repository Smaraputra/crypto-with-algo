import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StreamHealth } from './StreamHealth';

const mockUseMarketStreamStatus = vi.fn();

vi.mock('@/hooks/useMarketStream', () => ({
  useMarketStreamStatus: (market?: string) => mockUseMarketStreamStatus(market),
}));

describe('StreamHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when status is live', () => {
    mockUseMarketStreamStatus.mockReturnValue({
      status: 'live',
      retry: vi.fn(),
    });

    const { container } = render(<StreamHealth market="perp" />);
    expect(container).toBeEmptyDOMElement();
    expect(mockUseMarketStreamStatus).toHaveBeenCalledWith('perp');
  });

  it('renders loading notice when connecting', () => {
    mockUseMarketStreamStatus.mockReturnValue({
      status: 'connecting',
      retry: vi.fn(),
    });

    render(<StreamHealth market="perp" />);
    expect(screen.getByText('Connecting to live prices.')).toBeInTheDocument();
  });

  it('renders error notice and triggers retry when stale', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    mockUseMarketStreamStatus.mockReturnValue({
      status: 'stale',
      retry,
    });

    render(<StreamHealth market="perp" />);
    expect(
      screen.getByText('Live prices paused. Showing the last update.')
    ).toBeInTheDocument();

    const reconnectBtn = screen.getByRole('button', { name: /reconnect/i });
    await user.click(reconnectBtn);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
