import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NotesScreen } from '@/components/notes';

export const metadata: Metadata = {
  title: 'Notes | CryptoWithAlgo',
};

export default function NotesPage() {
  return (
    <Suspense fallback={null}>
      <NotesScreen />
    </Suspense>
  );
}
