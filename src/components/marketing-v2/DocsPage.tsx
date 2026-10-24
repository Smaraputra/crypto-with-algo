import React from 'react';

export function DocsPage() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-12 px-4 py-12 sm:px-6 sm:py-16">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Documentation
        </h1>
        <p className="mt-2 text-base text-ink-2 leading-relaxed">
          Platform guide, feature descriptions, data sources, and system constraints.
        </p>
      </header>

      {/* Getting started */}
      <section className="rounded-panel border border-line bg-card p-6 sm:p-8">
        <h2 className="text-xl font-semibold text-foreground sm:text-2xl">
          Getting started
        </h2>
        <div className="mt-4 space-y-4 text-sm leading-relaxed text-ink-2">
          <p>
            CryptoWithAlgo is an open market tracker and research notebook. All features are free to use with no exchange connection, deposits, or API keys.
          </p>
          <ul className="list-disc pl-5 space-y-2">
            <li>
              <strong className="text-foreground">Create your account:</strong> Register with an email address to save your coin watchlist, track holdings, and record trade journal notes.
            </li>
            <li>
              <strong className="text-foreground">Explore market feeds:</strong> Use the dashboard to monitor live prices and 24-hour changes from Binance public market data.
            </li>
            <li>
              <strong className="text-foreground">Evaluate trading costs:</strong> Before executing trades elsewhere, run your position size and hold length through Cost Check to see fees, slippage, and funding.
            </li>
            <li>
              <strong className="text-foreground">Follow open experiments:</strong> Visit the research lab to follow trading ideas tested on live data, where ideas that fail stay on the record after you sign in.
            </li>
          </ul>
        </div>
      </section>

      {/* Feature reference */}
      <section className="rounded-panel border border-line bg-card p-6 sm:p-8">
        <h2 className="text-xl font-semibold text-foreground sm:text-2xl">
          Feature reference
        </h2>
        <div className="mt-4 space-y-4 text-sm leading-relaxed text-ink-2">
          <p>
            Detailed descriptions of platform tools and metrics:
          </p>
          <ul className="list-disc pl-5 space-y-2.5">
            <li>
              <strong className="text-foreground">Market and chart:</strong> Live prices and charts from Binance public market data, with the 24-hour change.
            </li>
            <li>
              <strong className="text-foreground">Coin study:</strong> A chart with structure overlays, a 50-period moving average and MACD, a summary across 15m, 1h, 4h and 1d, headlines, and the round-trip cost for a hold length.
            </li>
            <li>
              <strong className="text-foreground">Research lab:</strong> Trading ideas are tested on live data, and ideas that fail stay on the record. You see each test and where it stands after you sign in.
            </li>
            <li>
              <strong className="text-foreground">Price score:</strong> Context only, measured on years of history with no edge after costs.
            </li>
            <li>
              <strong className="text-foreground">Portfolio:</strong> Holdings, value over time, cost basis with FIFO, LIFO, and HIFO, and CSV export of transactions.
            </li>
            <li>
              <strong className="text-foreground">Journal and notes:</strong> Log trades with the price score at the time, tag mistakes, see stats, get discipline reminders, and keep plain text research notes.
            </li>
            <li>
              <strong className="text-foreground">Price alerts:</strong> Price and percent-move alerts shown in the app.
            </li>
            <li>
              <strong className="text-foreground">Cost Check:</strong> Fees, slippage, and funding for your own position size and hold, before you trade.
            </li>
            <li>
              <strong className="text-foreground">Backtest:</strong> Test a price score configuration on stored history, with fees and a session breakdown.
            </li>
          </ul>
        </div>
      </section>

      {/* Data and limits */}
      <section className="rounded-panel border border-line bg-card p-6 sm:p-8">
        <h2 className="text-xl font-semibold text-foreground sm:text-2xl">
          Data and limits
        </h2>
        <div className="mt-4 space-y-4 text-sm leading-relaxed text-ink-2">
          <p>
            Important details on how data is sourced, updated, and constrained:
          </p>
          <ul className="list-disc pl-5 space-y-2.5">
            <li>
              <strong className="text-foreground">Binance public data:</strong> All spot and USDT-M perpetual market prices, orderbook snapshots, and candle series are sourced directly from Binance public API endpoints.
            </li>
            <li>
              <strong className="text-foreground">24h figures:</strong> Price changes, highs, lows, and quote volumes represent rolling 24-hour periods reported by the underlying exchange feeds, updating continuously.
            </li>
            <li>
              <strong className="text-foreground">Regional blocks:</strong> Access to public market data feeds may be unavailable or restricted for users residing in regions where Binance API services are blocked by local regulatory policies or internet service providers.
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
