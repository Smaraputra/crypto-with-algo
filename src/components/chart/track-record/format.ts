import type { PointMeasures } from '@/lib/signals/track-record/types';

/** Text builders for the track-record panel. Pure, so every sentence is tested. */

/** Fixed three-letter names: locale data varies ("Sep" or "Sept") and would misalign the month bars. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** UTC date as "1 Oct 2026". */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "2026-03" -> "Mar" or "Mar 2026". */
export function formatMonth(key: string, withYear = false): string {
  const [y, m] = key.split('-').map(Number);
  return withYear ? `${MONTHS[m - 1]} ${y}` : MONTHS[m - 1];
}

/** A share in [0, 1] as a percent with one decimal: 0.4613 -> "46.1%". */
export function share(v: number | null): string {
  return v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
}

/** A return in percent with its sign: 0.4213 -> "+0.42%". */
export function signed(v: number | null, digits = 2): string {
  if (v === null) return 'n/a';
  const fixed = v.toFixed(digits);
  return `${v >= 0 && !fixed.startsWith('-') ? '+' : ''}${fixed}%`;
}

export function count(n: number): string {
  return n.toLocaleString('en-US');
}

/** Fewer than this many calls on either side and a year cannot be judged (the research rule). */
export const MIN_SIDE_CALLS = 30;

export function assessable(m: PointMeasures): boolean {
  return m.buyN >= MIN_SIDE_CALLS && m.sellN >= MIN_SIDE_CALLS;
}

/** The focal answer: how often the calls were right against the two bars that matter. */
export function rightSentence(m: PointMeasures, costPercent: number): string {
  if (m.right === null) return 'No buy or sell call in this year.';
  const base = `Right ${share(m.right)} of the time. A coin flip is right 50%.`;
  if (m.breakEven === null) return base;
  if (m.breakEven >= 1) {
    return `${base} With these move sizes, ${costPercent.toFixed(2)}% costs could not be beaten even by calls that were always right.`;
  }
  return `${base} Breaking even after ${costPercent.toFixed(2)}% costs needed about ${share(m.breakEven)}.`;
}

/** The money answer: the average result of acting on every call. */
export function netSentence(m: PointMeasures): string {
  if (m.net === null) return '';
  const verb = m.net < 0 ? 'lost' : 'made';
  return `Acting on every call ${verb} ${Math.abs(m.net).toFixed(2)}% per call on average after costs.`;
}

const VERDICTS: Record<string, string> = {
  'NO DETECTABLE EDGE': 'no detectable edge',
  'NOT ASSESSABLE': 'too few calls to judge',
  RIGHT: 'right more often than chance',
  'WRONG-WAY': 'wrong more often than chance',
  PAYS: 'paid after costs',
};

export function verdictText(verdict: string): string {
  return VERDICTS[verdict] ?? verdict.toLowerCase();
}

/** Months that had calls, and how many of them averaged below zero after costs. */
export function monthsBelowZero(months: ReadonlyArray<{ net: number | null }>): { below: number; withCalls: number } {
  let below = 0;
  let withCalls = 0;
  for (const m of months) {
    if (m.net === null) continue;
    withCalls++;
    if (m.net < 0) below++;
  }
  return { below, withCalls };
}

export const STYLE_NAMES: Record<string, string> = {
  scalping: 'Scalping',
  day_trading: 'Day trading',
  swing_trading: 'Swing',
  position_trading: 'Position',
};
