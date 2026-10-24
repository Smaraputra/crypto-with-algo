'use client';

import React from 'react';
import Link from 'next/link';
import { StateNotice } from './StateNotice';
import { Button } from '@/components/ui/button';

export interface RouteErrorProps {
  title: string;
  reset: () => void;
  digest?: string;
  className?: string;
}

export const RouteError: React.FC<RouteErrorProps> = ({
  title,
  reset,
  digest,
  className,
}) => {
  return (
    <StateNotice
      kind="error"
      title={title}
      className={className}
      description={
        <span>
          <span className="block">
            Something went wrong while loading this page. Your data is safe.
          </span>
          {digest ? (
            <span className="block text-[13px] text-muted-foreground mt-1">
              Reference: {digest}
            </span>
          ) : null}
        </span>
      }
      action={
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            type="button"
            onClick={reset}
            className="min-h-[44px] rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold px-5 cursor-pointer shadow-none"
          >
            Try again
          </Button>
          <Button
            variant="outline"
            asChild
            className="min-h-[44px] rounded-[12px] font-semibold px-5 shadow-none"
          >
            <Link href="/dashboard">Go to Market</Link>
          </Button>
        </div>
      }
    />
  );
};
