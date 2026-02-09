'use client';

import dynamic from 'next/dynamic';

const CoinScene = dynamic(() => import('./CoinScene'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center">
      <div className="h-32 w-32 animate-pulse rounded-full bg-accent/10" />
    </div>
  ),
});

export function CoinSceneWrapper() {
  return (
    <section className="py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4">
        <h2 className="text-center text-2xl font-bold tracking-tight sm:text-3xl">
          Next-Generation Technology
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">
          Built on cutting-edge infrastructure for speed, reliability, and precision.
        </p>
        <div
          className="mx-auto mt-10 h-[300px] w-full max-w-md sm:h-[400px]"
          data-testid="coin-scene"
        >
          <CoinScene />
        </div>
      </div>
    </section>
  );
}
