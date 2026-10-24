import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ResearchHub } from '@/components/signals-hub';

export const metadata: Metadata = {
  title: 'Signals and research | CryptoWithAlgo',
};

export default function SignalsPage() {
  return (
    <Suspense>
      <ResearchHub />
    </Suspense>
  );
}
