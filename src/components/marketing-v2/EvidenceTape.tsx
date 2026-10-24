'use client';

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Tape } from '@/components/kit/Tape';
import { cn } from '@/lib/utils';

/**
 * Static illustrative sequence of 40 bets (wins and losses mixed).
 * Toy rule: evidence starts at 1.0; each win (add: true) multiplies
 * evidence by 1.18, and each loss (add: false) multiplies evidence by 0.85.
 * The running evidence ends below the validation threshold of 800.
 */
export const ILLUSTRATIVE_BETS: { add: boolean }[] = [
  { add: true },
  { add: true },
  { add: false },
  { add: true },
  { add: true },
  { add: false },
  { add: true },
  { add: true },
  { add: true },
  { add: false },
  { add: true },
  { add: true },
  { add: false },
  { add: true },
  { add: false },
  { add: true },
  { add: true },
  { add: true },
  { add: false },
  { add: true },
  { add: true },
  { add: false },
  { add: true },
  { add: true },
  { add: false },
  { add: true },
  { add: true },
  { add: false },
  { add: true },
  { add: false },
  { add: true },
  { add: true },
  { add: false },
  { add: true },
  { add: true },
  { add: false },
  { add: true },
  { add: false },
  { add: true },
  { add: false },
];

export const TAPE_THRESHOLD = 800;

export function calculateEvidence(bets: { add: boolean }[], start = 1): number {
  return bets.reduce((acc, bet) => acc * (bet.add ? 1.18 : 0.85), start);
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

export function EvidenceTape({ className }: { className?: string }) {
  const [revealed, setRevealed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot
  );

  const evidence = calculateEvidence(ILLUSTRATIVE_BETS);

  useEffect(() => {
    if (reducedMotion) return;

    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          setRevealed(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [reducedMotion]);

  return (
    <section
      aria-label="How evidence builds"
      className={cn('rounded-panel border border-line bg-card p-6 sm:p-10', className)}
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center lg:gap-12">
        <div className="max-w-xl">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            How evidence builds
          </h2>
          <p className="mt-4 text-base leading-relaxed text-ink-2">
            Each idea in the lab bets a small, fixed stake on live bars, after trading costs. Wins add evidence and losses take it away.
          </p>
          <p className="mt-2 text-base leading-relaxed text-ink-2">
            An idea counts as validated only when its evidence crosses a line set before its test began. Ideas that fail stay on the lab record.
          </p>
          <div className="mt-6">
            <Link
              href="/lab"
              className="inline-flex items-center min-h-[44px] text-sm font-semibold text-foreground hover:text-foreground/80 underline underline-offset-4"
            >
              Open the lab
            </Link>
          </div>
        </div>

        <div className="w-full">
          <div className="flex items-center justify-between text-xs text-ink-2 mb-2">
            <span className="font-medium">Evidence</span>
            <span className="tabular-nums font-semibold text-foreground">
              {evidence.toFixed(1)}{' '}
              <span className="text-ink-2 font-normal">/ {TAPE_THRESHOLD}</span>
            </span>
          </div>

          <div
            ref={containerRef}
            className={cn('relative', revealed && !reducedMotion && 'tape-reveal-animate')}
          >
            <Tape
              bets={ILLUSTRATIVE_BETS}
              evidence={evidence}
              threshold={TAPE_THRESHOLD}
              className="h-14"
            />
          </div>

          <p className="mt-2 text-xs text-ink-2">Illustration, not live data.</p>
        </div>
      </div>
    </section>
  );
}
