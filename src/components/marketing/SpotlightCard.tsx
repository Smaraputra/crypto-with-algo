'use client';

import { useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';

interface SpotlightCardProps {
  children: React.ReactNode;
  className?: string;
  as?: 'div' | 'article';
  'data-testid'?: string;
}

export function SpotlightCard({
  children,
  className,
  as: Tag = 'div',
  'data-testid': testId,
}: SpotlightCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const card = cardRef.current;
      if (!card) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
      card.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
    },
    []
  );

  return (
    <Tag
      ref={cardRef}
      onMouseMove={handleMouseMove}
      data-testid={testId}
      className={cn(
        'group relative overflow-hidden rounded-xl border border-border/50 bg-card transition-all duration-300 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5',
        className
      )}
      style={
        {
          '--mouse-x': '50%',
          '--mouse-y': '50%',
        } as React.CSSProperties
      }
    >
      {/* Border shine overlay */}
      <div
        className="pointer-events-none absolute inset-0 z-10 rounded-xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(300px circle at var(--mouse-x) var(--mouse-y), oklch(0.72 0.18 160 / 0.12), transparent 60%)',
          mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          maskComposite: 'exclude',
          WebkitMaskComposite: 'xor',
          padding: '1px',
        }}
      />
      {/* Spotlight fill */}
      <div
        className="pointer-events-none absolute inset-0 z-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(250px circle at var(--mouse-x) var(--mouse-y), oklch(0.72 0.18 160 / 0.06), transparent 80%)',
        }}
      />
      {/* Grid overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        aria-hidden="true"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, oklch(1 0 0 / 0.4) 0px, oklch(1 0 0 / 0.4) 1px, transparent 1px, transparent 40px), repeating-linear-gradient(90deg, oklch(1 0 0 / 0.4) 0px, oklch(1 0 0 / 0.4) 1px, transparent 1px, transparent 40px)',
        }}
      />
      <div className="relative z-20">{children}</div>
    </Tag>
  );
}
