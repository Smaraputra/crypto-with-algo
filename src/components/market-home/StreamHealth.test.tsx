import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamHealth } from './StreamHealth';
import { useMarketStreamStatus } from '@/hooks/useMarketStream';

vi.mock('@/hooks/useMarketStream', () => ({
  useMarketStreamStatus: vi.fn(),
}));

describe('StreamHealth', () => {
  const retryMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when status is live', () => {
    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'live',
      lastMessageAt: Date.now(),
      isConnected: true,
      retry: retryMock,
    });

    const { container } = render(<StreamHealth />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders "Connecting to live prices." when connecting', () => {
    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'connecting',
      lastMessageAt: null,
      isConnected: false,
      retry: retryMock,
    });

    render(<StreamHealth />);
    expect(screen.getByText('Connecting to live prices.')).toBeInTheDocument();
  });

  it('renders "Reconnecting to live prices." when reconnecting', () => {
    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'reconnecting',
      lastMessageAt: null,
      isConnected: false,
      retry: retryMock,
    });

    render(<StreamHealth />);
    expect(screen.getByText('Reconnecting to live prices.')).toBeInTheDocument();
  });

  it('renders "Live prices paused. Showing the last update." and Reconnect calls retry when stale', async () => {
    const user = userEvent.setup();
    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'stale',
      lastMessageAt: Date.now() - 30_000,
      isConnected: true,
      retry: retryMock,
    });

    render(<StreamHealth />);
    expect(
      screen.getByText('Live prices paused. Showing the last update.')
    ).toBeInTheDocument();

    const button = screen.getByRole('button', { name: 'Reconnect' });
    await user.click(button);
    expect(retryMock).toHaveBeenCalledTimes(1);
  });

  it('renders "Live prices are offline." and Reconnect calls retry when offline', async () => {
    const user = userEvent.setup();
    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'offline',
      lastMessageAt: null,
      isConnected: false,
      retry: retryMock,
    });

    render(<StreamHealth />);
    expect(screen.getByText('Live prices are offline.')).toBeInTheDocument();

    const button = screen.getByRole('button', { name: 'Reconnect' });
    await user.click(button);
    expect(retryMock).toHaveBeenCalledTimes(1);
  });
});
