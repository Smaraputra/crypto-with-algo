import React from 'react';

export function FeaturesPage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-12 px-4 py-12 sm:px-6 sm:py-16">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Features
        </h1>
        <p className="mt-2 text-base text-ink-2 max-w-2xl leading-relaxed">
          Real tools and transparent data for tracking cryptocurrency markets, managing positions, and studying trade ideas.
        </p>
      </header>

      {/* Group 1: Market and coins */}
      <section className="rounded-panel border border-line bg-card p-6 sm:p-8">
        <h2 className="text-xl font-semibold text-foreground sm:text-2xl">
          Market and coins
        </h2>
        <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Market overview
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
              Live prices and charts from Binance public market data, with the 24-hour change.
            </p>
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Coin study
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
              A chart with structure overlays, a 50-period moving average and MACD, a summary across 15m, 1h, 4h and 1d, headlines, and round-trip trading costs for your hold length.
            </p>
          </div>
        </div>
      </section>

      {/* Group 2: Research */}
      <section className="rounded-panel border border-line bg-card p-6 sm:p-8">
        <h2 className="text-xl font-semibold text-foreground sm:text-2xl">
          Research
        </h2>
        <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Research lab
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
              Trading ideas are tested on live data, and ideas that fail stay on the record. You see each test and where it stands after you sign in.
            </p>
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Price score
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
              Context only, measured on years of history with no edge after costs.
            </p>
          </div>
        </div>
      </section>

      {/* Group 3: Your trades */}
      <section className="rounded-panel border border-line bg-card p-6 sm:p-8">
        <h2 className="text-xl font-semibold text-foreground sm:text-2xl">
          Your trades
        </h2>
        <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Portfolio
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
              Track holdings and value over time. Inspect cost basis with FIFO, LIFO, and HIFO, and download transactions as a CSV export.
            </p>
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Journal and notes
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
              Log trades with the price score at the time, tag mistakes, see stats, and get discipline reminders. Keep plain text notes for your research.
            </p>
          </div>
        </div>
      </section>

      {/* Group 4: Tools */}
      <section className="rounded-panel border border-line bg-card p-6 sm:p-8">
        <h2 className="text-xl font-semibold text-foreground sm:text-2xl">
          Tools
        </h2>
        <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-3">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Price alerts
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
              Price and percent-move alerts shown in the app.
            </p>
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Cost Check
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
              Calculate fees, slippage, and funding for your own position size and hold, before you trade.
            </p>
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Backtest
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
              Test a price score configuration on stored history, with fees and a session breakdown.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
