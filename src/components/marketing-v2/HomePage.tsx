import React from 'react';
import Link from 'next/link';
import { PriceStrip } from './PriceStrip';
import { SessionCta } from './SessionCta';

export function HomePage() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-16 px-4 py-12 sm:gap-20 sm:px-6 sm:py-16">
      {/* Hero section */}
      <section className="flex flex-col items-center text-center">
        <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
          A crypto market tracker with an open research lab
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-ink-2 sm:text-lg">
          Track live crypto prices, study a coin with its trading costs, and follow an open record of trading ideas tested on live data.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <SessionCta className="rounded-full bg-brand px-5 py-2.5 text-[15px] font-semibold text-brand-foreground transition-opacity hover:opacity-90" />
          <Link
            href="/how-it-works"
            className="rounded-xl border border-edge px-5 py-2.5 text-[15px] font-medium text-foreground transition-colors hover:bg-card"
          >
            See how it works
          </Link>
        </div>
      </section>

      {/* Live price strip */}
      <section aria-label="Live market prices" className="rounded-panel border border-line bg-card/60 p-2">
        <PriceStrip />
      </section>

      {/* Real capabilities section (varied layout, not identical icon cards) */}
      <section className="flex flex-col gap-8">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            What you can do
          </h2>
          <p className="mt-2 text-base text-ink-2">
            Practical tools built around real market data and neutral calculations.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
          {/* Main feature highlight panel */}
          <div className="rounded-panel border border-line bg-card p-6 md:col-span-7 sm:p-8">
            <h3 className="text-lg font-semibold text-foreground">
              Market and coin study
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              Live prices and charts from Binance public market data, with structure overlays, moving averages, and multi-timeframe summaries.
            </p>
            <div className="mt-6 border-t border-line pt-4">
              <ul className="space-y-1.5 text-sm text-ink-2">
                <li>Live prices and charts with the 24-hour change</li>
                <li>Structure overlays, 50-period moving average, and MACD</li>
                <li>Estimated round-trip trading costs by hold length</li>
              </ul>
            </div>
          </div>

          {/* Secondary feature highlight panel */}
          <div className="rounded-panel border border-line bg-card p-6 md:col-span-5 sm:p-8">
            <h3 className="text-lg font-semibold text-foreground">
              Portfolio and journal
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              Holdings tracking with FIFO, LIFO, and HIFO cost basis calculations, CSV export, and a trade journal with mistake tags and plain text notes.
            </p>
            <div className="mt-6 border-t border-line pt-4">
              <ul className="space-y-1.5 text-sm text-ink-2">
                <li>Cost basis tracking and CSV export of transactions</li>
                <li>Trade logging with mistake tags and discipline reminders</li>
                <li>Plain text research notes</li>
              </ul>
            </div>
          </div>

          {/* Tools row */}
          <div className="rounded-panel border border-line bg-card p-6 md:col-span-4">
            <h3 className="text-base font-semibold text-foreground">
              Cost Check
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
              Calculate fees, slippage, and funding for your position size and hold length before you trade.
            </p>
          </div>

          <div className="rounded-panel border border-line bg-card p-6 md:col-span-4">
            <h3 className="text-base font-semibold text-foreground">
              Price alerts
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
              Price and percent-move alerts shown in the app.
            </p>
          </div>

          <div className="rounded-panel border border-line bg-card p-6 md:col-span-4">
            <h3 className="text-base font-semibold text-foreground">
              Backtest
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
              Test a price score configuration on stored history, with fees and a session breakdown.
            </p>
          </div>
        </div>
      </section>

      {/* The open research lab section */}
      <section className="rounded-panel border border-line bg-card p-6 sm:p-10">
        <div className="max-w-3xl">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Research in the open
          </h2>
          <p className="mt-4 text-base leading-relaxed text-ink-2">
            Every idea is tested on live data, and ideas that fail stay on the record. The price score was measured on years of history and showed no edge after costs, so it is shown as context only. Sign in to see each test and where it stands.
          </p>
        </div>
      </section>

      {/* Call to action section */}
      <section className="flex flex-col items-center rounded-panel border border-line bg-card/40 py-12 px-6 text-center sm:py-16">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          Start tracking with honest data
        </h2>
        <p className="mt-3 max-w-xl text-base text-ink-2">
          Free account with no exchange connection, deposits, or API keys.
        </p>
        <div className="mt-6">
          <SessionCta className="rounded-full bg-brand px-6 py-3 text-[15px] font-semibold text-brand-foreground transition-opacity hover:opacity-90" />
        </div>
      </section>
    </div>
  );
}
