'use client';

import dynamic from 'next/dynamic';
import type { TradeCostProps } from './TradeCost';

// The inputs come from localStorage, which exists only in the browser, so the
// section renders on the client only (the same reason src/app/(dashboard)/cost-check/page.tsx gives).
const TradeCost = dynamic(
  () => import('./TradeCost').then((m) => m.TradeCost),
  {
    ssr: false,
    loading: () => (
      <p className="p-4 text-sm text-muted-foreground">Loading costs...</p>
    ),
  }
);

export function LazyTradeCost(props: TradeCostProps) {
  return <TradeCost {...props} />;
}
