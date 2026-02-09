'use client';

import type { SignalTier } from '@/types/signal';

interface SignalGaugeProps {
  score: number; // -100 to +100
  tier: SignalTier;
  confidence?: number; // 0 to 100
  size?: number; // SVG viewport width
}

const TIER_LABELS: Record<SignalTier, string> = {
  strong_buy: 'Strong Buy',
  buy: 'Buy',
  neutral: 'Neutral',
  sell: 'Sell',
  strong_sell: 'Strong Sell',
};

const TIER_COLORS: Record<SignalTier, string> = {
  strong_buy: 'var(--signal-strong-buy)',
  buy: 'var(--signal-buy)',
  neutral: 'var(--signal-neutral)',
  sell: 'var(--signal-sell)',
  strong_sell: 'var(--signal-strong-sell)',
};

export function SignalGauge({ score, tier, confidence, size = 240 }: SignalGaugeProps) {
  const cx = size / 2;
  const cy = size * 0.6;
  const radius = size * 0.38;
  const strokeWidth = size * 0.06;

  // Map score (-100 to +100) to angle (180 to 0 degrees, left to right)
  // -100 = 180deg (far left, bearish), +100 = 0deg (far right, bullish)
  const clampedScore = Math.max(-100, Math.min(100, score));
  const angle = 180 - ((clampedScore + 100) / 200) * 180;
  const angleRad = (angle * Math.PI) / 180;

  // Needle endpoint
  const needleLength = radius * 0.85;
  const needleX = cx + needleLength * Math.cos(angleRad);
  const needleY = cy - needleLength * Math.sin(angleRad);

  // Arc path for the semicircle (from 180 deg to 0 deg)
  const arcStartX = cx - radius;
  const arcStartY = cy;
  const arcEndX = cx + radius;
  const arcEndY = cy;

  // Gradient stops for the arc (red -> yellow -> green)
  const gradientId = `gauge-gradient-${size}`;

  const tierColor = TIER_COLORS[tier];
  const tierLabel = TIER_LABELS[tier];

  return (
    <div className="flex flex-col items-center" data-testid="signal-gauge">
      <svg
        viewBox={`0 0 ${size} ${size * 0.7}`}
        width={size}
        height={size * 0.7}
        role="img"
        aria-label={`Signal gauge: ${tierLabel} (${Math.round(score)})`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--signal-strong-sell)" />
            <stop offset="25%" stopColor="var(--signal-sell)" />
            <stop offset="50%" stopColor="var(--signal-neutral)" />
            <stop offset="75%" stopColor="var(--signal-buy)" />
            <stop offset="100%" stopColor="var(--signal-strong-buy)" />
          </linearGradient>
        </defs>

        {/* Background arc */}
        <path
          d={`M ${arcStartX} ${arcStartY} A ${radius} ${radius} 0 0 1 ${arcEndX} ${arcEndY}`}
          fill="none"
          stroke="hsl(var(--muted))"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />

        {/* Colored arc */}
        <path
          d={`M ${arcStartX} ${arcStartY} A ${radius} ${radius} 0 0 1 ${arcEndX} ${arcEndY}`}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          opacity={0.85}
        />

        {/* Needle */}
        <line
          x1={cx}
          y1={cy}
          x2={needleX}
          y2={needleY}
          stroke={tierColor}
          strokeWidth={2.5}
          strokeLinecap="round"
        />

        {/* Center dot */}
        <circle cx={cx} cy={cy} r={size * 0.025} fill={tierColor} />

        {/* Score text */}
        <text
          x={cx}
          y={cy - radius * 0.15}
          textAnchor="middle"
          fill="hsl(var(--foreground))"
          fontSize={size * 0.14}
          fontWeight="bold"
          fontFamily="monospace"
          data-testid="gauge-score"
        >
          {Math.round(score)}
        </text>

        {/* Min/Max labels */}
        <text
          x={arcStartX}
          y={cy + size * 0.08}
          textAnchor="middle"
          fill="hsl(var(--muted-foreground))"
          fontSize={size * 0.04}
        >
          -100
        </text>
        <text
          x={arcEndX}
          y={cy + size * 0.08}
          textAnchor="middle"
          fill="hsl(var(--muted-foreground))"
          fontSize={size * 0.04}
        >
          +100
        </text>
      </svg>

      {/* Tier label below gauge */}
      <div
        className="font-mono text-lg font-semibold -mt-2"
        style={{ color: tierColor }}
        data-testid="gauge-tier"
      >
        {tierLabel}
      </div>

      {/* Confidence indicator */}
      {confidence !== undefined && (
        <div className="text-xs text-muted-foreground mt-1" data-testid="gauge-confidence">
          {confidence}% confidence
        </div>
      )}
    </div>
  );
}
