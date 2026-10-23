import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PortfolioScreen } from '@/components/portfolio-v2';

export const metadata: Metadata = {
  title: 'Portfolio | CryptoWithAlgo',
};

export default function PortfolioPage() {
  return (
    <Suspense fallback={null}>
      <PortfolioScreen />
    </Suspense>
  );
}
