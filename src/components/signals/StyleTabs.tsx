'use client';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { TradingStyle } from '@/lib/models/signal-template';

export const STYLE_LABELS: Record<TradingStyle, string> = {
  scalping: 'Scalping',
  day_trading: 'Day Trading',
  swing_trading: 'Swing',
  position_trading: 'Position',
};

const STYLE_ORDER: TradingStyle[] = [
  'scalping',
  'day_trading',
  'swing_trading',
  'position_trading',
];

interface StyleTabsProps {
  value: TradingStyle;
  onValueChange: (style: TradingStyle) => void;
}

export function StyleTabs({ value, onValueChange }: StyleTabsProps) {
  return (
    <Tabs
      value={value}
      onValueChange={(v) => onValueChange(v as TradingStyle)}
      data-testid="style-tabs"
    >
      <TabsList>
        {STYLE_ORDER.map((style) => (
          <TabsTrigger
            key={style}
            value={style}
            className="text-xs"
            data-testid={`style-tab-${style}`}
          >
            {STYLE_LABELS[style]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
