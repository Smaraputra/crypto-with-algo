'use client';

import React from 'react';
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
  return (
    <div
      className={cn(
        'flex flex-col gap-6 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6',
        className
      )}
    >
      <h1 className="sr-only">Market</h1>

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
