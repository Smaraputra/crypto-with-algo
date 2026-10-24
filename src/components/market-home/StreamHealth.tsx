'use client';

import React from 'react';
import { useMarketStreamStatus } from '@/hooks/useMarketStream';
import { StateNotice } from '@/components/kit/StateNotice';
import { cn } from '@/lib/utils';
import type { StreamMarket } from '@/lib/market-stream/client';

export interface StreamHealthProps {
  market?: StreamMarket;
  className?: string;
}

export const StreamHealth: React.FC<StreamHealthProps> = ({
  market = 'spot',
  className,
}) => {
  const { status, retry } = useMarketStreamStatus(market);
  const isLive = status === 'live';
  const [showNotice, setShowNotice] = React.useState(false);
  const [prevIsLive, setPrevIsLive] = React.useState(isLive);

  if (isLive !== prevIsLive) {
    setPrevIsLive(isLive);
    if (isLive) {
      setShowNotice(false);
    }
  }

  React.useEffect(() => {
    if (isLive) {
      return;
    }

    const timer = setTimeout(() => {
      setShowNotice(true);
    }, 4000);

    return () => {
      clearTimeout(timer);
    };
  }, [isLive, market]);

  if (isLive || !showNotice) {
    return null;
  }

  const reconnectButton = (
    <button
      type="button"
      onClick={retry}
      className={cn(
        'min-h-[44px] h-[44px] px-4 inline-flex items-center justify-center rounded-[12px] border border-edge bg-card text-[14px] font-semibold text-foreground cursor-pointer',
        'hover:border-foreground focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline transition-colors duration-120',
        'active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100'
      )}
    >
      Reconnect
    </button>
  );

  if (status === 'connecting') {
    return (
      <StateNotice
        kind="loading"
        title="Connecting to live prices."
        className={cn('py-3 px-4 [&_[data-testid=skeleton-rows]]:hidden', className)}
      />
    );
  }

  if (status === 'reconnecting') {
    return (
      <StateNotice
        kind="loading"
        title="Reconnecting to live prices."
        className={cn('py-3 px-4 [&_[data-testid=skeleton-rows]]:hidden', className)}
      />
    );
  }

  if (status === 'stale') {
    return (
      <StateNotice
        kind="error"
        title="Live prices paused. Showing the last update."
        action={reconnectButton}
        className={cn('py-3 px-4', className)}
      />
    );
  }

  if (status === 'offline') {
    return (
      <StateNotice
        kind="error"
        title="Live prices are offline."
        action={reconnectButton}
        className={cn('py-3 px-4', className)}
      />
    );
  }

  return null;
};
