'use client';

import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DisciplineNudge } from '@/lib/discipline';

interface DisciplineBannerProps {
  nudges: DisciplineNudge[];
  compact?: boolean;
}

export function DisciplineBanner({ nudges, compact = false }: DisciplineBannerProps) {
  if (nudges.length === 0) return null;

  return (
    <div className={cn('space-y-1.5', compact && 'space-y-1')} data-testid="discipline-banner">
      {nudges.map((nudge) => (
        <div
          key={nudge.rule}
          className={cn(
            'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
            nudge.severity === 'warning'
              ? 'border-bearish/30 bg-bearish/10 text-bearish'
              : 'border-accent/30 bg-accent/10 text-muted-foreground'
          )}
          data-testid={`discipline-nudge-${nudge.rule}`}
        >
          {nudge.severity === 'warning' ? (
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <Info className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span>{nudge.message}</span>
        </div>
      ))}
    </div>
  );
}
