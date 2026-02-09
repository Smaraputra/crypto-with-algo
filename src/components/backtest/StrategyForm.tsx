'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { VALID_INTERVALS, VALID_SYMBOLS } from '@/types/strategy';
import { DEFAULT_WEIGHTS } from '@/types/signal';
import type { CreateStrategyInput, Strategy } from '@/types/strategy';
import type { SignalWeights } from '@/types/signal';

interface StrategyFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: CreateStrategyInput) => void;
  isPending: boolean;
  initial?: Strategy;
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

function StrategyFormInner({
  onSubmit,
  isPending,
  initial,
}: Pick<StrategyFormProps, 'onSubmit' | 'isPending' | 'initial'>) {
  const [name, setName] = useState(initial?.name ?? '');
  const [symbols, setSymbols] = useState<string[]>(initial?.symbols ?? []);
  const [intervals, setIntervals] = useState<(typeof VALID_INTERVALS[number])[]>(
    (initial?.intervals as (typeof VALID_INTERVALS[number])[]) ?? ['1h']
  );
  const [weights, setWeights] = useState<SignalWeights>(
    initial ? { ...initial.weights } : { ...DEFAULT_WEIGHTS }
  );

  const totalWeight = WEIGHT_KEYS.reduce((sum, k) => sum + weights[k], 0);
  const isWeightValid = Math.abs(totalWeight - 1.0) < 0.01;
  const isValid = name.trim().length > 0 && symbols.length > 0 && intervals.length > 0 && isWeightValid;

  const toggleSymbol = (symbol: string) => {
    setSymbols((prev) =>
      prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol]
    );
  };

  const toggleInterval = (interval: typeof VALID_INTERVALS[number]) => {
    setIntervals((prev) =>
      prev.includes(interval)
        ? prev.filter((i) => i !== interval)
        : [...prev, interval]
    );
  };

  const updateWeight = (key: keyof SignalWeights, value: number) => {
    setWeights((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = () => {
    if (!isValid) return;
    onSubmit({ name: name.trim(), symbols, intervals, weights });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="strategy-name" className="text-xs">Name</Label>
        <Input
          id="strategy-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Strategy"
          maxLength={50}
          className="h-8 text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Symbols</Label>
        <div className="flex flex-wrap gap-1.5">
          {VALID_SYMBOLS.map((symbol) => (
            <Button
              key={symbol}
              type="button"
              size="sm"
              variant={symbols.includes(symbol) ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => toggleSymbol(symbol)}
            >
              {symbol.replace('USDT', '')}
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Intervals</Label>
        <div className="flex gap-2">
          {VALID_INTERVALS.map((iv) => (
            <Button
              key={iv}
              type="button"
              size="sm"
              variant={intervals.includes(iv) ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => toggleInterval(iv)}
            >
              {iv}
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Weights</Label>
          <span
            className={`text-xs font-mono tabular-nums ${
              isWeightValid ? 'text-green-500' : 'text-red-500'
            }`}
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
              aria-label={`${WEIGHT_LABELS[key]} weight`}
            />
          </div>
        ))}
      </div>

      <Button
        onClick={handleSubmit}
        disabled={!isValid || isPending}
        className="w-full"
        data-testid="strategy-submit"
      >
        {isPending ? 'Saving...' : initial ? 'Update Strategy' : 'Create Strategy'}
      </Button>
    </div>
  );
}

export function StrategyForm({
  open,
  onOpenChange,
  onSubmit,
  isPending,
  initial,
}: StrategyFormProps) {
  // Use key to force remount and reset state when initial or open changes
  const formKey = `${initial?._id ?? 'new'}-${open}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" data-testid="strategy-form">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit Strategy' : 'New Strategy'}</DialogTitle>
        </DialogHeader>
        <StrategyFormInner
          key={formKey}
          onSubmit={onSubmit}
          isPending={isPending}
          initial={initial}
        />
      </DialogContent>
    </Dialog>
  );
}
