import React from 'react';

export function HowItWorksPage() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-12 px-4 py-12 sm:px-6 sm:py-16">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          How it works
        </h1>
        <p className="mt-2 text-base text-ink-2 leading-relaxed">
          A step by step walkthrough of how you navigate markets, study coin setups, and track your execution.
        </p>
      </header>

      <div className="flex flex-col gap-8">
        {/* Step 1 */}
        <section className="rounded-panel border border-line bg-card p-6 sm:p-8">
          <h2 className="text-xl font-semibold text-foreground">
            1. Create an account
          </h2>
          <p className="mt-3 text-base leading-relaxed text-ink-2">
            Sign up with your email address. All features are free with no exchange connection, deposits, or API keys. Your portfolio holdings and notes stay private to your account.
          </p>
        </section>

        {/* Step 2 */}
        <section className="rounded-panel border border-line bg-card p-6 sm:p-8">
          <h2 className="text-xl font-semibold text-foreground">
            2. Pick coins
          </h2>
          <p className="mt-3 text-base leading-relaxed text-ink-2">
            Choose the symbols you wish to watch from Binance public market data. Track live prices and the 24-hour change from a single clean dashboard.
          </p>
        </section>

        {/* Step 3 */}
        <section className="rounded-panel border border-line bg-card p-6 sm:p-8">
          <h2 className="text-xl font-semibold text-foreground">
            3. Study a coin with its costs
          </h2>
          <p className="mt-3 text-base leading-relaxed text-ink-2">
            Inspect coins with a chart, structure overlays, a 50-period moving average, and MACD. Use Cost Check to evaluate fees, slippage, and funding for your position size and hold length before you trade.
          </p>
        </section>

        {/* Step 4 */}
        <section className="rounded-panel border border-line bg-card p-6 sm:p-8">
          <h2 className="text-xl font-semibold text-foreground">
            4. Record trades and notes
          </h2>
          <p className="mt-3 text-base leading-relaxed text-ink-2">
            Log trades in your journal with the price score at the time, tag mistakes, track cost basis with FIFO, LIFO, and HIFO, and keep plain text research notes.
          </p>
        </section>

        {/* Step 5 */}
        <section className="rounded-panel border border-line bg-card p-6 sm:p-8">
          <h2 className="text-xl font-semibold text-foreground">
            5. Follow the lab&apos;s record
          </h2>
          <p className="mt-3 text-base leading-relaxed text-ink-2">
            Follow trading ideas tested on live data, where ideas that fail stay on the record. You see each test and where it stands after you sign in.
          </p>
        </section>
      </div>
    </div>
  );
}
