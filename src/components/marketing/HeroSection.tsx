'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useGSAP } from '@gsap/react';
import { gsap } from '@/lib/gsap';
import { cn } from '@/lib/utils';
import { HeroBackground } from './HeroBackground';
import { LandingButton } from './LandingButton';

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

function AnimatedTicker() {
  const [tickers, setTickers] = useState(MOCK_TICKERS);
  const tickerRef = useRef<HTMLDivElement>(null);

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
      ref={tickerRef}
      className="flex flex-wrap justify-center gap-3"
      data-testid="hero-ticker"
      role="status"
      aria-label="Live cryptocurrency prices"
      aria-live="polite"
    >
      {tickers.map((t) => (
        <div
          key={t.symbol}
          className="flex items-center gap-2 rounded-lg border border-border bg-card/50 px-3 py-2 backdrop-blur-sm"
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
  const sectionRef = useRef<HTMLElement>(null);
  const headlineRef = useRef<HTMLHeadingElement>(null);

  useGSAP(
    () => {
      if (!sectionRef.current) return;
      const prefersReduced = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches;

      const elements = sectionRef.current.querySelectorAll('[data-hero-anim]');
      if (prefersReduced) {
        // Show everything immediately
        gsap.set(elements, { opacity: 1, y: 0 });
        return;
      }

      // Staggered entry for all hero elements
      gsap.from(elements, {
        opacity: 0,
        y: 30,
        duration: 0.7,
        stagger: 0.15,
        ease: 'power3.out',
        delay: 0.2,
      });

      // Headline typewriter effect on the accent part
      if (headlineRef.current) {
        const accentSpan =
          headlineRef.current.querySelector('[data-type-text]');
        if (accentSpan) {
          const fullText = accentSpan.textContent || '';
          gsap.from(accentSpan, {
            text: { value: '', delimiter: '' },
            duration: 1.2,
            delay: 0.6,
            ease: 'none',
          });
          // Ensure final text is correct
          gsap.set(accentSpan, { text: fullText, delay: 1.9 });
        }
      }
    },
    { scope: sectionRef }
  );

  return (
    <section
      ref={sectionRef}
      className="relative overflow-hidden pt-28 pb-16 sm:pt-36 sm:pb-24"
    >
      <HeroBackground />

      <div className="relative mx-auto max-w-4xl px-4 text-center">
        <h1
          ref={headlineRef}
          className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl"
          data-hero-anim
        >
          Algorithmic Crypto Intelligence
          <br />
          <span className="text-primary" data-type-text>
            Powered by AlgoCrypto
          </span>
        </h1>
        <p
          className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground"
          data-hero-anim
        >
          Live market data from Binance, interactive trading charts, portfolio
          analytics, and smart price alerts -- all in one dashboard.
        </p>

        <div
          className="mt-8 flex flex-wrap items-center justify-center gap-4"
          data-hero-anim
        >
          <LandingButton variant="solid" size="lg" href="/register">
            Get Started Free
            <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
          </LandingButton>
          <LandingButton variant="outline" size="lg" href="/login">
            Sign In
          </LandingButton>
        </div>

        <div className="mt-12" data-hero-anim>
          <AnimatedTicker />
        </div>
      </div>
    </section>
  );
}
