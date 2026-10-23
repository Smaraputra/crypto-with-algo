import type { Metadata } from 'next';
import { Suspense } from 'react';
import { JournalScreen } from '@/components/journal-v2';

export const metadata: Metadata = {
  title: 'Journal | CryptoWithAlgo',
};

export default function JournalPage() {
  return (
    <Suspense fallback={null}>
      <JournalScreen />
    </Suspense>
  );
}
