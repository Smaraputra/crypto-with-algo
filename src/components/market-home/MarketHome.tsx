'use client';

import React from 'react';
import { useSession } from 'next-auth/react';
import { PageHeader } from '@/components/kit';
import { CoinTabs } from './CoinTabs';
import { StreamHealth } from './StreamHealth';
import { PriceHero } from './PriceHero';
import { MarketChart } from './MarketChart';
import { LabGlance } from './LabGlance';
import { PriceScoreGlance } from './PriceScoreGlance';
import { MarketFoot } from './MarketFoot';
import { cn } from '@/lib/utils';

export interface MarketHomeProps {
  className?: string;
}

export const MarketHome: React.FC<MarketHomeProps> = ({ className }) => {
  const { data: session, status } = useSession();
  const firstName = session?.user?.name?.trim().split(/\s+/)[0];
  // While the session loads, a blank line holds the welcome line's space so the page does not shift.
  const welcome = firstName ? `Welcome, ${firstName}.` : status === 'loading' ? '\u00a0' : undefined;

  return (
    <div
      className={cn(
        'flex flex-col gap-6 w-full py-6',
        className
      )}
    >
      <PageHeader title="Market" description={welcome} />

      <CoinTabs />

      <StreamHealth />

      <PriceHero />

      <MarketChart />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <LabGlance />
        <PriceScoreGlance />
      </div>

      <MarketFoot />
    </div>
  );
};
