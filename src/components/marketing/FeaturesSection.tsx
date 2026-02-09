'use client';

import { useCallback, useRef } from 'react';
import {
  Briefcase,
  TrendingUp,
  Bell,
  BarChart3,
  CandlestickChart,
  Download,
} from 'lucide-react';
import { useGSAP } from '@gsap/react';
import { gsap, ScrollTrigger } from '@/lib/gsap';

const FEATURES = [
  {
    icon: Briefcase,
    title: 'Portfolio Management',
    description:
      'Track holdings across multiple portfolios with real-time valuations and P&L.',
  },
  {
    icon: TrendingUp,
    title: 'Live Market Data',
    description:
      'WebSocket-powered price feeds from Binance with sub-second updates.',
  },
  {
    icon: Bell,
    title: 'Smart Alerts',
    description:
      'Set price, portfolio value, and percentage-change alerts with recurring options.',
  },
  {
    icon: BarChart3,
    title: 'Analytics Dashboard',
    description:
      'Portfolio history charts, risk metrics, Sharpe ratio, and drawdown analysis.',
  },
  {
    icon: CandlestickChart,
    title: 'Interactive Charts',
    description:
      'Professional candlestick charts with MA, EMA, BOLL, and volume overlays.',
  },
  {
    icon: Download,
    title: 'Tax Export',
    description:
      'FIFO/LIFO/HIFO cost basis with Generic, Koinly, and CoinTracker CSV exports.',
  },
];

export function FeaturesSection() {
  const sectionRef = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (!sectionRef.current) return;
      const prefersReduced = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches;

      const cards =
        sectionRef.current.querySelectorAll<HTMLElement>('[data-feature-card]');

      if (prefersReduced) {
        gsap.set(cards, { opacity: 1, y: 0 });
        return;
      }

      gsap.from(cards, {
        opacity: 0,
        y: 30,
        duration: 0.5,
        stagger: 0.1,
        ease: 'power3.out',
        scrollTrigger: {
          trigger: sectionRef.current,
          start: 'top 75%',
          once: true,
        },
      });

      return () => {
        ScrollTrigger.getAll().forEach((t) => t.kill());
      };
    },
    { scope: sectionRef }
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const card = e.currentTarget;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
      card.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
    },
    []
  );

  return (
    <section
      ref={sectionRef}
      id="features"
      className="py-16 sm:py-24"
    >
      <div className="mx-auto max-w-6xl px-4">
        <h2 className="text-center text-2xl font-bold tracking-tight sm:text-3xl">
          <span className="gradient-heading">Everything You Need</span>
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">
          Professional-grade tools for managing your cryptocurrency portfolio.
        </p>

        <div className="gradient-separator mx-auto mt-6 max-w-xs" />

        <div
          className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="features-grid"
        >
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              data-feature-card
              onMouseMove={handleMouseMove}
              className="grid-card-overlay group relative overflow-hidden rounded-xl border border-border/50 bg-card p-6 transition-all duration-300 hover:border-[#0ecb81]/30 hover:shadow-lg hover:shadow-[#0ecb81]/5"
              style={
                {
                  '--mouse-x': '50%',
                  '--mouse-y': '50%',
                } as React.CSSProperties
              }
            >
              {/* Mouse spotlight */}
              <div
                className="pointer-events-none absolute inset-0 z-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                aria-hidden="true"
                style={{
                  background:
                    'radial-gradient(250px circle at var(--mouse-x) var(--mouse-y), oklch(0.72 0.18 160 / 0.06), transparent 80%)',
                }}
              />
              <div className="relative z-10">
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-primary/20 bg-primary/5">
                  <feature.icon className="h-5 w-5 text-primary transition-transform duration-300 group-hover:scale-110" />
                </div>
                <h3 className="text-sm font-semibold">{feature.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {feature.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
