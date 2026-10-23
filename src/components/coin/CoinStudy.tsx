'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/kit/PageHeader';
import { useUIStore } from '@/stores/uiStore';
import { getBaseAsset } from '@/components/market-home/formatters';
import { StreamHealth } from './StreamHealth';
import { CoinChart } from './CoinChart';
import { TimeframesPanel } from './TimeframesPanel';
import { CoinEvidencePanel } from './CoinEvidencePanel';
import { CostPanel } from './CostPanel';
import { CoinHeadlines } from './CoinHeadlines';
import { cn } from '@/lib/utils';

export interface CoinStudyProps {
  symbol?: string;
  className?: string;
}

export const CoinStudy: React.FC<CoinStudyProps> = ({ symbol: propSymbol, className }) => {
  const storeSymbol = useUIStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUIStore((s) => s.setSelectedSymbol);

  const coin = propSymbol || storeSymbol || 'BTCUSDT';
  const [holdMinutes, setHoldMinutes] = useState<number>(60);

  const initializedRef = useRef<string | null>(null);
  useEffect(() => {
    if (propSymbol && initializedRef.current !== propSymbol) {
      initializedRef.current = propSymbol;
      setSelectedSymbol(propSymbol);
    }
  }, [propSymbol, setSelectedSymbol]);

  const baseAsset = getBaseAsset(coin);

  const actionButtonClasses = cn(
    'min-h-[44px] h-[44px] px-4 inline-flex items-center justify-center rounded-[10px] border border-edge bg-card text-[14px] font-semibold text-foreground cursor-pointer select-none',
    'hover:border-foreground focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline transition-colors duration-120',
    'active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100'
  );

  return (
    <div className={cn('space-y-6', className)}>
      <PageHeader
        title={`${baseAsset} study`}
        description="USDT-M perpetual"
        actions={
          <div className="flex items-center gap-2.5 flex-wrap">
            <Link
              href="/signals"
              onClick={() => setSelectedSymbol(coin)}
              className={actionButtonClasses}
            >
              Score detail
            </Link>
            <Link
              href={`/cost-check?symbol=${coin}&holdMinutes=${holdMinutes}`}
              className={actionButtonClasses}
            >
              Open Cost Check
            </Link>
          </div>
        }
      />

      <StreamHealth market="perp" />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] xl:grid-cols-[1fr_420px] gap-6 items-start">
        <div className="space-y-6 min-w-0">
          <CoinChart symbol={coin} />
        </div>

        <div className="space-y-6 min-w-0">
          <TimeframesPanel symbol={coin} />
          <CoinEvidencePanel symbol={coin} />
          <CostPanel symbol={coin} onHoldChange={setHoldMinutes} />
        </div>
      </div>

      <CoinHeadlines symbol={coin} />
    </div>
  );
};
