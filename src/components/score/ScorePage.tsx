'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/kit/PageHeader';
import { SegmentedControl } from '@/components/kit/SegmentedControl';
import { useUIStore } from '@/stores/uiStore';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { scoredIntervals } from '@/lib/indicators/style-configs';
import type { TradingStyle } from '@/lib/models/signal-template';
import { getBaseAsset } from '@/components/market-home/formatters';
import { ScoreReading } from './ScoreReading';
import { ScoreComponents } from './ScoreComponents';
import { ScoreHistory } from './ScoreHistory';
import { FuturesContext } from './FuturesContext';
import { cn } from '@/lib/utils';

export const STYLE_OPTIONS = [
  { value: 'scalping', label: 'Scalping' },
  { value: 'day_trading', label: 'Day trading' },
  { value: 'swing_trading', label: 'Swing trading' },
  { value: 'position_trading', label: 'Position trading' },
];

export interface ScorePageProps {
  className?: string;
}

export const ScorePage: React.FC<ScorePageProps> = ({ className }) => {
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUIStore((s) => s.setSelectedSymbol);

  const symbol = selectedSymbol || 'BTCUSDT';
  const base = getBaseAsset(symbol);

  const [style, setStyle] = useState<TradingStyle>('day_trading');
  const availableIntervals = scoredIntervals(style);
  const [interval, setInterval] = useState<string>(availableIntervals[0] ?? '1h');

  const handleStyleChange = (newStyleVal: string) => {
    const newStyle = newStyleVal as TradingStyle;
    setStyle(newStyle);
    const newIntervals = scoredIntervals(newStyle);
    if (!newIntervals.includes(interval)) {
      setInterval(newIntervals[0] ?? '1h');
    }
  };

  const intervalOptions = availableIntervals.map((iv) => ({
    value: iv,
    label: iv,
  }));

  return (
    <div className={cn('space-y-6 max-w-6xl mx-auto py-6 px-4 sm:px-6', className)}>
      <PageHeader
        title="Price score"
        description={`The composite score as context for ${base}. Measured on years of history: no edge after costs.`}
      />

      {/* Controls */}
      <div className="flex items-center gap-4 flex-wrap">
        {/* Coin select */}
        <div className="flex items-center gap-2">
          <label htmlFor="coin-select" className="text-[14px] font-semibold text-foreground">
            Coin
          </label>
          <select
            id="coin-select"
            aria-label="Coin"
            value={symbol}
            onChange={(e) => setSelectedSymbol(e.target.value)}
            className="min-h-[44px] h-[44px] px-3.5 py-2 rounded-[12px] border border-edge bg-card text-[14px] font-semibold text-foreground cursor-pointer focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px]"
          >
            {SIGNAL_SYMBOLS.map((sym) => (
              <option key={sym} value={sym}>
                {sym}
              </option>
            ))}
          </select>
        </div>

        {/* Style SegmentedControl */}
        <SegmentedControl
          legend="Style"
          name="style-control"
          options={STYLE_OPTIONS}
          value={style}
          onChange={handleStyleChange}
        />

        {/* Interval SegmentedControl */}
        <SegmentedControl
          legend="Interval"
          name="interval-control"
          options={intervalOptions}
          value={interval}
          onChange={setInterval}
        />
      </div>

      {/* Main content blocks */}
      <div className="space-y-6">
        <ScoreReading symbol={symbol} style={style} interval={interval} />

        <ScoreComponents symbol={symbol} style={style} interval={interval} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ScoreHistory symbol={symbol} style={style} interval={interval} />
          <FuturesContext symbol={symbol} />
        </div>

        <div className="pt-2">
          <Link
            href="/lab"
            className="text-[14px] font-semibold text-foreground hover:underline inline-flex items-center min-h-[44px] py-2 focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px]"
          >
            See the full measured record on the lab page
          </Link>
        </div>
      </div>
    </div>
  );
};
