import type { SignalTier } from '@/types/signal';

/**
 * How a tier is SHOWN, in one place.
 *
 * The labels describe the composite score, not an action. "Strong Buy" read
 * as advice, and the research record says the opposite of what advice would
 * need: the rule built on this score loses after costs at every interval it
 * was measured on (see `src/lib/trade-plan/evidence.ts`). Review finding P2,
 * 2026-10-01. The tier KEYS are unchanged, so stored signals, outcomes and
 * calibration statistics are untouched; only the display text moved.
 */
export const TIER_DISPLAY_LABELS: Record<SignalTier, string> = {
  strong_buy: 'Strong long score',
  buy: 'Long score',
  neutral: 'Neutral',
  sell: 'Short score',
  strong_sell: 'Strong short score',
};

/** The display label for a tier key; an unknown key falls back to readable words. */
export function tierDisplayLabel(tier: string): string {
  return (TIER_DISPLAY_LABELS as Record<string, string>)[tier] ?? tier.replace(/_/g, ' ');
}
