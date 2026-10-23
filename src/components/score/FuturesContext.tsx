'use client';

import React from 'react';
import { Panel } from '@/components/kit/Panel';
import {
  useFundingRate,
  useOpenInterest,
  useLongShortRatio,
} from '@/hooks/useFutures';

export function formatSignedPercentRate(rate: number): string {
  const pct = rate * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '-' : '+';
  return `${sign}${Math.abs(pct).toFixed(4)}%`;
}

export interface FuturesContextProps {
  symbol?: string;
  className?: string;
}

export const FuturesContext: React.FC<FuturesContextProps> = ({
  symbol = 'BTCUSDT',
  className,
}) => {
  const {
    data: fundingData,
    isError: fundingError,
    isLoading: fundingLoading,
  } = useFundingRate(symbol);

  const {
    data: oiData,
    isError: oiError,
    isLoading: oiLoading,
  } = useOpenInterest(symbol, true);

  const {
    data: lsData,
    isError: lsError,
    isLoading: lsLoading,
  } = useLongShortRatio(symbol, '1h', 'top');

  // Line 1: Funding rate
  const latestFunding = fundingData?.fundingRates?.[0];
  const hasFunding =
    latestFunding &&
    typeof latestFunding.fundingRate === 'number' &&
    Number.isFinite(latestFunding.fundingRate);

  let fundingContent: React.ReactNode;
  if (fundingError) {
    fundingContent = 'Did not load.';
  } else if (fundingLoading) {
    fundingContent = 'Loading...';
  } else if (hasFunding) {
    fundingContent = `${formatSignedPercentRate(latestFunding.fundingRate)}.`;
  } else {
    fundingContent = 'Did not load.';
  }

  // Line 2: Open interest
  const rawOi = oiData?.openInterest?.openInterest;
  const hasOi = typeof rawOi === 'number' && Number.isFinite(rawOi);

  let oiContent: React.ReactNode;
  if (oiError) {
    oiContent = 'Did not load.';
  } else if (oiLoading) {
    oiContent = 'Loading...';
  } else if (hasOi) {
    const formattedVal = new Intl.NumberFormat('en-US').format(rawOi);
    const history = oiData?.history;
    let changeSuffix = '';
    if (history && history.length >= 2) {
      const prev = history[0].sumOpenInterest;
      if (prev > 0) {
        const pctChange = ((rawOi - prev) / prev) * 100;
        const sign = pctChange > 0 ? '+' : pctChange < 0 ? '-' : '+';
        changeSuffix = ` (${sign}${Math.abs(pctChange).toFixed(2)}%)`;
      }
    }
    oiContent = `${formattedVal}${changeSuffix}.`;
  } else {
    oiContent = 'Did not load.';
  }

  // Line 3: Long and short accounts
  const latestLs =
    lsData?.longShortRatio?.[lsData.longShortRatio.length - 1] ??
    lsData?.longShortRatio?.[0];
  const rawRatio = latestLs?.longShortRatio;
  const hasRatio = typeof rawRatio === 'number' && Number.isFinite(rawRatio);

  let lsContent: React.ReactNode;
  if (lsError) {
    lsContent = 'Did not load.';
  } else if (lsLoading) {
    lsContent = 'Loading...';
  } else if (hasRatio) {
    lsContent = `${rawRatio.toFixed(2)}.`;
  } else {
    lsContent = 'Did not load.';
  }

  return (
    <Panel title="Futures context" className={className}>
      <div className="flex flex-col gap-2.5 text-[14px]">
        <p data-testid="futures-funding" className="text-muted-foreground font-sans tabular-nums">
          <span className="font-medium text-foreground">Latest funding rate:</span>{' '}
          {fundingContent}
        </p>
        <p data-testid="futures-oi" className="text-muted-foreground font-sans tabular-nums">
          <span className="font-medium text-foreground">Open interest:</span> {oiContent}
        </p>
        <p data-testid="futures-ls" className="text-muted-foreground font-sans tabular-nums">
          <span className="font-medium text-foreground">Long and short accounts:</span>{' '}
          {lsContent}
        </p>
      </div>
    </Panel>
  );
};
