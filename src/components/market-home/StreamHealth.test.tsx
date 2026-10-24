import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamHealth } from './StreamHealth';
import { useMarketStreamStatus } from '@/hooks/useMarketStream';

vi.mock('@/hooks/useMarketStream', () => ({
  useMarketStreamStatus: vi.fn(),
}));

describe('StreamHealth', () => {
  const retryMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(useMarketStreamStatus).toHaveBeenCalledWith('spot');
  });

  it('reads perp status when market="perp"', () => {
    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'live',
      lastMessageAt: Date.now(),
      isConnected: true,
      retry: retryMock,
    });

    const { container } = render(<StreamHealth market="perp" />);
    expect(container).toBeEmptyDOMElement();
    expect(useMarketStreamStatus).toHaveBeenCalledWith('perp');
  });

  it('nothing renders before 4s of connecting', () => {
    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'connecting',
      lastMessageAt: null,
      isConnected: false,
      retry: retryMock,
    });

    const { container } = render(<StreamHealth />);
    expect(container).toBeEmptyDOMElement();

    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('the notice renders after 4s', () => {
    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'connecting',
      lastMessageAt: null,
      isConnected: false,
      retry: retryMock,
    });

    render(<StreamHealth />);
    expect(screen.queryByText('Connecting to live prices.')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText('Connecting to live prices.')).toBeInTheDocument();
  });

  it('it disappears at once on live', () => {
    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'connecting',
      lastMessageAt: null,
      isConnected: false,
      retry: retryMock,
    });

    const { rerender, container } = render(<StreamHealth />);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText('Connecting to live prices.')).toBeInTheDocument();

    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'live',
      lastMessageAt: Date.now(),
      isConnected: true,
      retry: retryMock,
    });
    rerender(<StreamHealth />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a reconnect shorter than 4s never shows it', () => {
    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'live',
      lastMessageAt: Date.now(),
      isConnected: true,
      retry: retryMock,
    });

    const { rerender, container } = render(<StreamHealth />);
    expect(container).toBeEmptyDOMElement();

    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'reconnecting',
      lastMessageAt: null,
      isConnected: false,
      retry: retryMock,
    });
    rerender(<StreamHealth />);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(container).toBeEmptyDOMElement();

    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'live',
      lastMessageAt: Date.now(),
      isConnected: true,
      retry: retryMock,
    });
    rerender(<StreamHealth />);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders "Reconnecting to live prices." after 4s when reconnecting', () => {
    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'reconnecting',
      lastMessageAt: null,
      isConnected: false,
      retry: retryMock,
    });

    render(<StreamHealth />);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText('Reconnecting to live prices.')).toBeInTheDocument();
  });

  it('renders "Live prices paused. Showing the last update." after 4s and Reconnect calls retry when stale', () => {
    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'stale',
      lastMessageAt: Date.now() - 30_000,
      isConnected: true,
      retry: retryMock,
    });

    render(<StreamHealth />);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(
      screen.getByText('Live prices paused. Showing the last update.')
    ).toBeInTheDocument();

    const button = screen.getByRole('button', { name: 'Reconnect' });
    fireEvent.click(button);
    expect(retryMock).toHaveBeenCalledTimes(1);
  });

  it('renders "Live prices are offline." after 4s and Reconnect calls retry when offline', () => {
    vi.mocked(useMarketStreamStatus).mockReturnValue({
      status: 'offline',
      lastMessageAt: null,
      isConnected: false,
      retry: retryMock,
    });

    render(<StreamHealth />);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText('Live prices are offline.')).toBeInTheDocument();

    const button = screen.getByRole('button', { name: 'Reconnect' });
    fireEvent.click(button);
    expect(retryMock).toHaveBeenCalledTimes(1);
  });
});
