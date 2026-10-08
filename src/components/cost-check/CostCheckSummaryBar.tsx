'use client';

import type { CostCheckModel } from '@/lib/costs/cost-check-model';
import { COST_TONE_LABEL, type CostTone } from '@/lib/costs/verdict';
import { cn } from '@/lib/utils';

const TONE_TEXT: Record<CostTone, string> = {
  small: 'text-foreground',
  material: 'text-accent',
  dominate: 'text-bearish',
  exceed: 'text-bearish',
};

/**
 * On narrow screens the verdict sits below a long form, out of sight while the
 * inputs change. This bar keeps its two key facts pinned to the bottom of the
 * viewport there; the full verdict card stays the accessible live region, so
 * the bar is hidden from assistive technology to avoid announcing twice.
 */
export function CostCheckSummaryBar({ model }: { model: CostCheckModel }) {
  const { verdict } = model;
  let tone: CostTone | null = null;
  let detail: string;
  if (verdict.kind === 'verdict') {
    tone = verdict.tone;
    detail =
      verdict.breakeven.kind === 'impossible'
        ? 'no win rate breaks even'
        : `needs ${(verdict.breakeven.winRate * 100).toFixed(1)}% right to break even`;
  } else if (verdict.kind === 'thin') {
    detail = 'too little history for a verdict';
  } else {
    detail = 'market data unavailable';
  }

  return (
    <div
      aria-hidden
      data-testid="cost-check-summary-bar"
      className="sticky bottom-0 -mx-4 border-t border-border bg-background/95 px-4 py-2 backdrop-blur lg:hidden"
    >
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        {tone && <span className={cn('font-semibold', TONE_TEXT[tone])}>{COST_TONE_LABEL[tone]}</span>}
        <span className="text-muted-foreground">{detail}</span>
        <span className="ml-auto font-mono tabular-nums">{model.verdictCostPercent.toFixed(3)}% round trip</span>
      </p>
    </div>
  );
}
