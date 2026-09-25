/**
 * Shared chart vocabulary for the calibration dashboard, so the four charts
 * read as one system rather than four separately styled plots.
 *
 * Colours are referenced as CSS variables, never as literals: the tier scale
 * and the configVersion ramp live in globals.css beside the rest of the theme,
 * and a hex copied in here is a hex that stops tracking the theme.
 *
 * On the tier scale: it is a DIVERGING scale (two hues either side of a neutral
 * grey midpoint), not a categorical one, because the tiers are ordered from
 * strong_sell to strong_buy. Its adjacent pairs were validated for
 * colour-vision separation against the dark surface. Even so, colour never
 * carries identity alone anywhere in this dashboard -- every tier mark is
 * accompanied by its name in an axis label, a legend row or a table cell.
 */
import type { SignalTier } from '@/types/signal';

export const TIER_COLOR: Record<SignalTier, string> = {
  strong_buy: 'var(--signal-strong-buy)',
  buy: 'var(--signal-buy)',
  neutral: 'var(--signal-neutral)',
  sell: 'var(--signal-sell)',
  strong_sell: 'var(--signal-strong-sell)',
};

export const TIER_LABEL: Record<SignalTier, string> = {
  strong_buy: 'Strong buy',
  buy: 'Buy',
  neutral: 'Neutral',
  sell: 'Sell',
  strong_sell: 'Strong sell',
};

/**
 * Ordered ramp for configVersion series. Assigned by position in the ascending
 * list of versions present, so the newest version is always the lightest and
 * most prominent step. Beyond three versions the ramp repeats rather than
 * inventing a hue -- at that point the honest move is to filter, since four
 * scorers on one axis is not a comparison anyone can read.
 */
export const CONFIG_VERSION_COLORS = [
  'var(--config-version-1)',
  'var(--config-version-2)',
  'var(--config-version-3)',
];

export function configVersionColor(index: number): string {
  return CONFIG_VERSION_COLORS[index % CONFIG_VERSION_COLORS.length];
}

/** Recessive axis and grid ink, so the data is the most prominent thing drawn. */
export const AXIS_COLOR = 'var(--color-muted-foreground)';
export const GRID_COLOR = 'var(--color-border)';
export const ZERO_LINE_COLOR = 'var(--color-border-strong)';

export const AXIS_TICK = { fill: 'var(--color-muted-foreground)', fontSize: 11 } as const;

export const TOOLTIP_STYLE = {
  backgroundColor: 'var(--color-popover)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: '6px',
  fontSize: '12px',
} as const;

/** Percent formatter for axes and labels: always signed, always 3 decimals.
 * Three because the numbers this dashboard exists to judge sit in the third
 * decimal place -- a 0.05% mean rounded to two is indistinguishable from zero. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
