'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LazyMotion, domAnimation, motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface TickerItem {
  symbol: string;
  price: string;
  change: number;
}

const MOCK_TICKERS: TickerItem[] = [
  { symbol: 'BTC', price: '67,432.18', change: 2.34 },
  { symbol: 'ETH', price: '3,521.45', change: -0.87 },
  { symbol: 'SOL', price: '142.67', change: 5.12 },
  { symbol: 'BNB', price: '612.33', change: 1.45 },
];

const containerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.15 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: 'easeOut' as const },
  },
};

function AnimatedTicker() {
  const [tickers, setTickers] = useState(MOCK_TICKERS);

  useEffect(() => {
    const interval = setInterval(() => {
      setTickers((prev) =>
        prev.map((t) => {
          const delta = (Math.random() - 0.5) * 0.4;
          return { ...t, change: +(t.change + delta).toFixed(2) };
        })
      );
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className="flex flex-wrap justify-center gap-3"
      data-testid="hero-ticker"
      role="status"
      aria-label="Live cryptocurrency prices"
      aria-live="polite"
    >
      {tickers.map((t) => (
        <div
          key={t.symbol}
          className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
        >
          <span className="text-xs font-medium text-muted-foreground">
            {t.symbol}
          </span>
          <span className="font-mono tabular-nums text-sm">${t.price}</span>
          <span
            className={cn(
              'font-mono tabular-nums text-xs font-medium',
              t.change >= 0 ? 'text-bullish' : 'text-bearish'
            )}
          >
            {t.change >= 0 ? '+' : ''}
            {t.change.toFixed(2)}%
          </span>
        </div>
      ))}
    </div>
  );
}

export function HeroSection() {
  return (
    <LazyMotion features={domAnimation}>
      <section className="relative overflow-hidden pt-28 pb-16 sm:pt-36 sm:pb-24">
        {/* Decorative gradient orbs */}
        <div
          className="absolute -top-40 left-1/4 h-80 w-80 rounded-full opacity-10 blur-[100px]"
          style={{ background: 'var(--bullish)' }}
        />
        <div
          className="absolute -bottom-20 right-1/4 h-60 w-60 rounded-full opacity-10 blur-[100px]"
          style={{ background: 'var(--accent)' }}
        />

        <motion.div
          className="relative mx-auto max-w-4xl px-4 text-center"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.h1
            className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl"
            variants={itemVariants}
          >
            Algorithmic Crypto Intelligence
            <br />
            <span className="text-primary">Powered by AlgoCrypto</span>
          </motion.h1>
          <motion.p
            className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground"
            variants={itemVariants}
          >
            Live market data from Binance, interactive trading charts, portfolio
            analytics, and smart price alerts -- all in one dashboard.
          </motion.p>

          <motion.div
            className="mt-8 flex flex-wrap items-center justify-center gap-4"
            variants={itemVariants}
          >
            <Button size="lg" asChild>
              <Link href="/register">Get Started Free</Link>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <Link href="/login">Sign In</Link>
            </Button>
          </motion.div>

          <motion.div className="mt-12" variants={itemVariants}>
            <AnimatedTicker />
          </motion.div>
        </motion.div>
      </section>
    </LazyMotion>
  );
}
