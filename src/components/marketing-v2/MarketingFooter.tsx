import React from 'react';
import Link from 'next/link';
import { BrandMark } from '@/components/kit';

export function MarketingFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="w-full border-t border-line bg-background py-8 text-[13px] text-muted-foreground">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 text-center sm:flex-row sm:px-6 sm:text-left">
        <BrandMark size="sm" />

        <div className="flex flex-wrap items-center justify-center gap-6">
          <Link
            href="/docs"
            className="inline-flex items-center min-h-[44px] transition-colors hover:text-foreground"
          >
            Docs
          </Link>
          <Link
            href="/privacy"
            className="inline-flex items-center min-h-[44px] transition-colors hover:text-foreground"
          >
            Privacy
          </Link>
          <Link
            href="/terms"
            className="inline-flex items-center min-h-[44px] transition-colors hover:text-foreground"
          >
            Terms
          </Link>
          <span className="inline-flex items-center min-h-[44px] tabular-nums">
            © {year}
          </span>
        </div>
      </div>
    </footer>
  );
}
