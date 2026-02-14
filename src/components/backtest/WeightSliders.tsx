'use client';

import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import type { SignalWeights } from '@/types/signal';

interface WeightSlidersProps {
  weights: SignalWeights;
  onChange: (weights: SignalWeights) => void;
  disabled?: boolean;
}

const WEIGHT_KEYS: (keyof SignalWeights)[] = [
  'trend', 'momentum', 'volume', 'volatility', 'futures', 'sentiment',
];

const WEIGHT_LABELS: Record<keyof SignalWeights, string> = {
  trend: 'Trend',
  momentum: 'Momentum',
  volume: 'Volume',
  volatility: 'Volatility',
  futures: 'Futures',
  sentiment: 'Sentiment',
};

export function WeightSliders({ weights, onChange, disabled }: WeightSlidersProps) {
  const totalWeight = WEIGHT_KEYS.reduce((sum, k) => sum + weights[k], 0);
  const isWeightValid = Math.abs(totalWeight - 1.0) < 0.01;

  function updateWeight(key: keyof SignalWeights, value: number) {
    onChange({ ...weights, [key]: value });
  }

  return (
    <div className="space-y-3" data-testid="weight-sliders">
      <div className="flex items-center justify-between">
        <Label className="text-xs">Weights</Label>
        <span
          className={`text-xs font-mono tabular-nums ${
            isWeightValid ? 'text-bullish' : 'text-bearish'
          }`}
          data-testid="weight-total"
        >
          Total: {(totalWeight * 100).toFixed(0)}%
        </span>
      </div>
      {WEIGHT_KEYS.map((key) => (
        <div key={key} className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {WEIGHT_LABELS[key]}
            </span>
            <span className="font-mono text-xs tabular-nums">
              {(weights[key] * 100).toFixed(0)}%
            </span>
          </div>
          <Slider
            value={[weights[key] * 100]}
            onValueChange={([v]) => updateWeight(key, v / 100)}
            min={0}
            max={100}
            step={5}
            className="h-4"
            disabled={disabled}
            aria-label={`${WEIGHT_LABELS[key]} weight`}
          />
        </div>
      ))}
    </div>
  );
}
