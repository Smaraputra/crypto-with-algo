'use client';

import dynamic from 'next/dynamic';

import { Skeleton } from '@/components/ui/skeleton';

// Inputs come from localStorage and the URL, which exist only in the browser;
// rendering the view on the client alone avoids a hydration mismatch.
const CostCheckView = dynamic(() => import('@/components/cost-check/CostCheckView').then((m) => m.CostCheckView), {
  ssr: false,
  loading: () => <Skeleton className="h-96 w-full" />,
});

export default function CostCheckPage() {
  return (
    <div className="space-y-4 p-4">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Cost Check</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          What fees, slippage and funding take from the move a trade can expect, before you place it. Most short-hold
          trades on Binance USDT-M perpetuals need a win rate no signal delivers just to pay their costs.
        </p>
      </div>
      <CostCheckView />
    </div>
  );
}
