import React from 'react';
import { cn } from '@/lib/utils';

export interface RouteLoadingProps {
  className?: string;
}

export function RouteLoading({ className }: RouteLoadingProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading"
      className={cn('space-y-6', className)}
    >
      <span className="sr-only">Loading</span>
      {/* Static grey block sized like a PageHeader */}
      <div className="space-y-2" aria-hidden="true">
        <div className="h-8 w-48 rounded-[6px] bg-muted" />
        <div className="h-4 w-72 max-w-full rounded-[6px] bg-muted" />
      </div>
      {/* Static grey blocks sized like Panels */}
      <div className="h-64 rounded-panel bg-muted" aria-hidden="true" />
      <div className="h-48 rounded-panel bg-muted" aria-hidden="true" />
    </div>
  );
}

export default RouteLoading;
