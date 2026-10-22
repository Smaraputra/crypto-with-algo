import { Suspense } from 'react';
import type { Metadata } from 'next';
import { FocusView } from '@/components/focus/FocusView';

export const metadata: Metadata = {
  title: 'Focus',
};

export default function FocusPage() {
  return (
    <Suspense>
      <FocusView />
    </Suspense>
  );
}
