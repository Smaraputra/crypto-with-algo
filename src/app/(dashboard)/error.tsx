'use client';

import React from 'react';
import Link from 'next/link';
import { StateNotice } from '@/components/kit/StateNotice';

export interface DashboardErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function DashboardError({ reset }: DashboardErrorProps) {
  return (
    <div className="mx-auto max-w-2xl py-12">
      <StateNotice
        kind="error"
        title="This page did not load."
        description="Something went wrong on our side. Try again, or go back to the market."
        action={
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => reset()}
              className="inline-flex min-h-[44px] cursor-pointer items-center justify-center rounded-md bg-foreground px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90 active:scale-[0.98] motion-reduce:active:scale-100"
            >
              Try again
            </button>
            <Link
              href="/dashboard"
              className="inline-flex min-h-[44px] cursor-pointer items-center justify-center rounded-md border border-edge px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted active:scale-[0.98] motion-reduce:active:scale-100"
            >
              Back to market
            </Link>
          </div>
        }
      />
    </div>
  );
}
