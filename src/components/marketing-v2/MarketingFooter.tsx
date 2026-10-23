import React from 'react';
import Link from 'next/link';

export function MarketingFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="w-full border-t border-line bg-background py-8 text-[13px] text-muted-foreground">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 text-center sm:flex-row sm:px-6 sm:text-left">
        <div className="flex flex-col gap-1 sm:gap-2">
          <p className="font-medium text-foreground">
            CryptoWithAlgo
          </p>
          <p>
            Not financial advice. Prices from Binance public market data.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-6">
          <Link
            href="/docs"
            className="transition-colors hover:text-foreground"
          >
            Docs
          </Link>
          <Link
            href="/privacy"
            className="transition-colors hover:text-foreground"
          >
            Privacy
          </Link>
          <Link
            href="/terms"
            className="transition-colors hover:text-foreground"
          >
            Terms
          </Link>
          <span className="tabular-nums">
            © {year}
          </span>
        </div>
      </div>
    </footer>
  );
}
