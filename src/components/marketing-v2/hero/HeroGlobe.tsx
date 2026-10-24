'use client';

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { useBinanceTicker } from '@/hooks/useBinanceStream';

export interface GlobeTick {
  id: number;
  dir: 1 | -1;
}

const GLOBE_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
];

const FALLBACK_DOTS = Array.from({ length: 60 }, (_, i) => {
  const fraction = (i + 0.5) / 60;
  const r = 210 * Math.sqrt(fraction);
  const theta = i * 2.399963229728653;
  return {
    cx: Number((260 + r * Math.cos(theta)).toFixed(1)),
    cy: Number((260 + r * Math.sin(theta)).toFixed(1)),
  };
});

export function GlobeSvgFallback() {
  return (
    <svg
      viewBox="0 0 520 520"
      aria-hidden="true"
      data-testid="globe-svg-fallback"
      className="w-full h-full text-ink-2/50"
      fill="none"
    >
      <circle
        cx="260"
        cy="260"
        r="230"
        stroke="currentColor"
        strokeWidth="1"
        strokeDasharray="4 4"
        opacity="0.35"
      />
      <circle
        cx="260"
        cy="260"
        r="215"
        stroke="currentColor"
        strokeWidth="0.5"
        opacity="0.2"
      />
      {FALLBACK_DOTS.map((dot, idx) => (
        <circle
          key={idx}
          cx={dot.cx}
          cy={dot.cy}
          r="2.5"
          fill="currentColor"
          opacity="0.75"
        />
      ))}
    </svg>
  );
}

const GlobeScene = dynamic(() => import('./GlobeScene'), {
  ssr: false,
  loading: () => <GlobeSvgFallback />,
});

export function isWebGLAvailable(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

function subscribeWebGL(): () => void {
  return () => {};
}
function getWebGLSnapshot(): boolean {
  return isWebGLAvailable();
}
function getWebGLServerSnapshot(): boolean {
  return true;
}

function subscribeReducedMotion(callback: () => void): () => void {
  const mediaQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  mediaQuery?.addEventListener?.('change', callback);
  return () => mediaQuery?.removeEventListener?.('change', callback);
}
function getReducedMotionSnapshot(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
}
function getReducedMotionServerSnapshot(): boolean {
  return false;
}

export function HeroGlobe({ className }: { className?: string }) {
  const [ticks, setTicks] = useState<GlobeTick[]>([]);
  const prevPricesRef = useRef<Record<string, number>>({});
  const counterRef = useRef<number>(0);

  const hasWebGL = useSyncExternalStore(subscribeWebGL, getWebGLSnapshot, getWebGLServerSnapshot);
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot
  );

  const { tickers } = useBinanceTicker(GLOBE_SYMBOLS);

  useEffect(() => {
    GLOBE_SYMBOLS.forEach((sym) => {
      const ticker = tickers[sym];
      if (!ticker || ticker.lastPrice === undefined || ticker.lastPrice === null) {
        return;
      }
      const priceNum = Number(ticker.lastPrice);
      if (isNaN(priceNum)) {
        return;
      }

      const prev = prevPricesRef.current[sym];
      if (prev === undefined) {
        // Skip first value per symbol
        prevPricesRef.current[sym] = priceNum;
        return;
      }

      if (priceNum !== prev) {
        const dir: 1 | -1 = priceNum >= prev ? 1 : -1;
        prevPricesRef.current[sym] = priceNum;
        const id = counterRef.current++;
        setTicks((prevTicks) => [...prevTicks, { id, dir }].slice(-24));
      }
    });
  }, [tickers]);

  return (
    <div
      data-testid="hero-globe"
      className={
        className ??
        'relative aspect-square w-full max-w-[320px] lg:max-w-[520px] mx-auto flex items-center justify-center'
      }
    >
      <div aria-hidden="true" className="w-full h-full">
        {!hasWebGL ? (
          <GlobeSvgFallback />
        ) : (
          <GlobeScene ticks={ticks} reducedMotion={reducedMotion} />
        )}
      </div>
      <p className="sr-only">A globe that flashes with each live price update.</p>
    </div>
  );
}
