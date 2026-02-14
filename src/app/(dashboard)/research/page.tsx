'use client';

import { PlaybookView } from '@/components/journal/PlaybookView';

export default function ResearchPage() {
  return (
    <div className="space-y-4 p-4">
      <h1 className="text-lg font-semibold">Research Notes</h1>
      <PlaybookView />
    </div>
  );
}
