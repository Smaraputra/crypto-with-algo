import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  StreamStatusBadge,
  statusSentence,
} from './StreamStatusBadge';
import type { StreamStatus } from '@/lib/market-stream/client';

describe('statusSentence', () => {
  const timestamp = Date.UTC(2026, 9, 18, 12, 1, 5);

  it('formats live status with timestamp', () => {
    const text = statusSentence('live', timestamp);
    expect(text).toContain('12:01:05 UTC');
    expect(text).toBe('Live prices through this site. Last update 12:01:05 UTC.');
  });

  it('formats live status without timestamp', () => {
    expect(statusSentence('live', null)).toBe('Live prices through this site.');
  });

  it('formats stale status with timestamp', () => {
    const text = statusSentence('stale', timestamp);
    expect(text).toContain('12:01:05 UTC');
    expect(text).toBe('No new prices for over 15 seconds. Last update 12:01:05 UTC.');
  });

  it('formats stale status without timestamp', () => {
    expect(statusSentence('stale', null)).toBe('No new prices for over 15 seconds.');
  });

  it('formats connecting status', () => {
    expect(statusSentence('connecting', timestamp)).toBe('Connecting to live prices.');
    expect(statusSentence('connecting', null)).toBe('Connecting to live prices.');
  });

  it('formats reconnecting status', () => {
    expect(statusSentence('reconnecting', timestamp)).toBe('Connection lost. Reconnecting.');
    expect(statusSentence('reconnecting', null)).toBe('Connection lost. Reconnecting.');
  });

  it('formats offline status', () => {
    expect(statusSentence('offline', timestamp)).toBe('Your device is offline.');
    expect(statusSentence('offline', null)).toBe('Your device is offline.');
  });
});

describe('StreamStatusBadge', () => {
  const statuses: Array<{
    status: StreamStatus;
    label: string;
    colorClass: string;
  }> = [
    {
      status: 'live',
      label: 'Live',
      colorClass: 'border-bullish/30 bg-bullish/10 text-bullish',
    },
    {
      status: 'stale',
      label: 'Stale',
      colorClass: 'border-accent/30 bg-accent/10 text-accent',
    },
    {
      status: 'connecting',
      label: 'Connecting',
      colorClass: 'border-accent/30 bg-accent/10 text-accent',
    },
    {
      status: 'reconnecting',
      label: 'Reconnecting',
      colorClass: 'border-accent/30 bg-accent/10 text-accent',
    },
    {
      status: 'offline',
      label: 'Offline',
      colorClass: 'border-bearish/30 bg-bearish/10 text-bearish',
    },
  ];

  for (const { status, label, colorClass } of statuses) {
    it(`renders exact label, colour class on the pill, and role="status" for ${status}`, () => {
      render(
        <StreamStatusBadge
          status={status}
          lastMessageAt={null}
          onRetry={vi.fn()}
        />
      );

      const pill = screen.getByRole('status');
      expect(pill).toBeInTheDocument();
      expect(pill).toHaveAttribute('aria-label', label);
      expect(pill).toHaveTextContent(label);

      for (const cls of colorClass.split(' ')) {
        expect(pill).toHaveClass(cls);
      }
    });
  }

  it('renders Retry button only for stale, reconnecting, and offline', () => {
    const onRetry = vi.fn();

    const { rerender } = render(
      <StreamStatusBadge
        status="live"
        lastMessageAt={null}
        onRetry={onRetry}
      />
    );
    expect(screen.queryByRole('button', { name: 'Retry live data' })).not.toBeInTheDocument();

    rerender(
      <StreamStatusBadge
        status="connecting"
        lastMessageAt={null}
        onRetry={onRetry}
      />
    );
    expect(screen.queryByRole('button', { name: 'Retry live data' })).not.toBeInTheDocument();

    rerender(
      <StreamStatusBadge
        status="stale"
        lastMessageAt={null}
        onRetry={onRetry}
      />
    );
    const retryStale = screen.getByRole('button', { name: 'Retry live data' });
    expect(retryStale).toBeInTheDocument();
    fireEvent.click(retryStale);
    expect(onRetry).toHaveBeenCalledTimes(1);

    onRetry.mockClear();
    rerender(
      <StreamStatusBadge
        status="reconnecting"
        lastMessageAt={null}
        onRetry={onRetry}
      />
    );
    const retryReconnecting = screen.getByRole('button', { name: 'Retry live data' });
    expect(retryReconnecting).toBeInTheDocument();
    fireEvent.click(retryReconnecting);
    expect(onRetry).toHaveBeenCalledTimes(1);

    onRetry.mockClear();
    rerender(
      <StreamStatusBadge
        status="offline"
        lastMessageAt={null}
        onRetry={onRetry}
      />
    );
    const retryOffline = screen.getByRole('button', { name: 'Retry live data' });
    expect(retryOffline).toBeInTheDocument();
    fireEvent.click(retryOffline);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('aria-label carries the label text', () => {
    const { rerender } = render(
      <StreamStatusBadge
        status="live"
        lastMessageAt={null}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Live');

    rerender(
      <StreamStatusBadge
        status="offline"
        lastMessageAt={null}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Offline');
  });

  it('sentence contains 12:01:05 UTC when status is live with timestamp', () => {
    const timestamp = Date.UTC(2026, 9, 18, 12, 1, 5);
    const sentence = statusSentence('live', timestamp);
    expect(sentence).toContain('12:01:05 UTC');
  });
});
