'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowRight, Activity, Zap, Heart } from 'lucide-react';
import { useGSAP } from '@gsap/react';
import { gsap } from '@/lib/gsap';
import { cn } from '@/lib/utils';
import { HeroBackground } from './HeroBackground';
import { LandingButton } from './LandingButton';

const GlobeSceneDynamic = dynamic(() => import('./GlobeScene'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center">
      <div className="h-32 w-32 animate-pulse rounded-full border border-primary/20" />
    </div>
  ),
});

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

const STATS = [
  { value: '24/7', suffix: '', label: 'Monitoring', icon: Activity },
  { value: '< 1s', suffix: '', label: 'Updates', icon: Zap },
  { value: '100%', suffix: '', label: 'Free', icon: Heart },
];

function CountUp({ value, suffix }: { value: string; suffix: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [displayed, setDisplayed] = useState(value + suffix);

  useEffect(() => {
    const prefersReduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;
    if (prefersReduced) return;

    // Only animate purely numeric values (skip "24/7" etc.)
    if (!/^\d+(\.\d+)?$/.test(value)) return;
    const numericPart = parseFloat(value);

    const duration = 1500;
    const start = performance.now();

    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      const current = numericPart * eased;

      if (value.includes('.')) {
        setDisplayed(current.toFixed(1) + suffix);
      } else {
        setDisplayed(Math.round(current) + suffix);
      }

      if (progress < 1) {
        requestAnimationFrame(tick);
      }
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          requestAnimationFrame(tick);
          observer.disconnect();
        }
      },
      { threshold: 0.5 }
    );

    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [value, suffix]);

  return <span ref={ref}>{displayed}</span>;
}

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
      className="flex flex-wrap justify-center gap-2 sm:gap-3"
      data-testid="hero-ticker"
      role="status"
      aria-label="Live cryptocurrency prices"
      aria-live="polite"
    >
      {tickers.map((t) => (
        <div
          key={t.symbol}
          className="flex items-center gap-2 rounded-full border border-border/50 bg-card/50 px-3 py-1.5 backdrop-blur-sm"
        >
          <span className="text-sm font-medium text-muted-foreground sm:text-xs">
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
  const globeRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (!sectionRef.current) return;
      const prefersReduced = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches;

      const elements = sectionRef.current.querySelectorAll('[data-hero-anim]');
      if (prefersReduced) {
        gsap.set(elements, { opacity: 1, y: 0 });
        return;
      }

      gsap.from(elements, {
        opacity: 0,
        y: 30,
        duration: 0.7,
        stagger: 0.15,
        ease: 'power3.out',
        delay: 0.2,
      });

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
          gsap.set(accentSpan, { text: fullText, delay: 1.9 });
        }
      }

      // Globe entrance + scroll parallax
      if (globeRef.current) {
        gsap.from(globeRef.current, {
          opacity: 0,
          y: 30,
          duration: 0.7,
          delay: 0.65,
          ease: 'power3.out',
          onComplete: () => {
            if (!globeRef.current || !sectionRef.current) return;
            gsap.to(globeRef.current, {
              y: -40,
              opacity: 0.6,
              ease: 'none',
              scrollTrigger: {
                trigger: sectionRef.current,
                start: 'top top',
                end: 'bottom top',
                scrub: 1,
              },
            });
          },
        });
      }
    },
    { scope: sectionRef }
  );

  return (
    <section
      ref={sectionRef}
      className="relative overflow-hidden pt-24 pb-12 sm:pt-36 sm:pb-24"
    >
      <HeroBackground />

      <div className="relative mx-auto max-w-6xl px-4 lg:max-w-6xl">
        {/* Two-column layout */}
        <div className="grid items-center gap-12 lg:grid-cols-2">
          {/* Left: text content */}
          <div className="text-center lg:text-left">
            <h1
              ref={headlineRef}
              className="text-3xl font-bold tracking-tight sm:text-4xl lg:text-6xl"
              data-hero-anim
            >
              Algorithmic Crypto Intelligence
              <br />
              {/* <span className="gradient-heading" data-type-text>
                Powered by CryptoWithAlgo
              </span> */}
            </h1>
            <p
              className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground lg:mx-0"
              data-hero-anim
            >
              Track cryptocurrency portfolios with live Binance data, technical charts,
              risk analytics, and intelligent price alerts, all free, no API keys needed.
            </p>

            <div
              className="mt-8 flex flex-wrap items-center justify-center gap-4 lg:justify-start"
              data-hero-anim
            >
              <LandingButton variant="solid" size="lg" href="/register">
                Get Started Free
                <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
              </LandingButton>
              <LandingButton variant="gradient-border" size="lg" href="/login">
                Sign In
              </LandingButton>
            </div>
          </div>

          {/* Right: globe */}
          <div
            ref={globeRef}
            className="relative mx-auto h-[250px] w-full max-w-lg lg:h-[400px]"
          >
            <GlobeSceneDynamic />
          </div>
        </div>

        {/* Gradient separator */}
        <div className="gradient-separator mt-12 sm:mt-16" />

        {/* Stats bar */}
        <div
          data-testid="stats-grid"
          className="mt-8 grid grid-cols-3 gap-4 sm:mt-10 sm:gap-3 md:grid-cols-3 lg:grid-cols-3"
          data-hero-anim
        >
          {STATS.map((stat) => (
            <article key={stat.label} className="text-center">
              <div className="flex items-center justify-center gap-1.5">
                <stat.icon className="h-4 w-4 text-muted-foreground" />
                <span className="gradient-heading font-mono text-xl font-bold tabular-nums sm:text-2xl">
                  <CountUp value={stat.value} suffix={stat.suffix} />
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground sm:text-xs">{stat.label}</p>
            </article>
          ))}
        </div>

        {/* Ticker */}
        <div className="mt-8" data-hero-anim>
          <AnimatedTicker />
        </div>
      </div>
    </section>
  );
}
