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
import { VALID_INTERVALS, VALID_SYMBOLS } from '@/types/strategy';
import { DEFAULT_WEIGHTS } from '@/types/signal';
import { WeightSliders } from './WeightSliders';
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

      <WeightSliders weights={weights} onChange={setWeights} />

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
