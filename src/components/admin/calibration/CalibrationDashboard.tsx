'use client';

/**
 * The calibration dashboard: what the live signal said against what the market
 * then did.
 *
 * Filters sit in one row above the charts and every one of them narrows the
 * whole page, so nothing on screen is ever a mix of two filter states. Style
 * and interval are a single control because the pair is what defines a horizon
 * -- offering them separately would let a style be combined with an interval it
 * does not score, which is the pooling defect this dashboard exists to avoid
 * reproducing.
 */
import { useState } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useCalibration } from '@/hooks/useCalibration';
import { STYLE_CONFIGS } from '@/lib/indicators/style-configs';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { TIER_BUY_CUTOFF } from '@/lib/signals/calibration';
import type { TradingStyle } from '@/lib/models/signal-template';

import { CoverageHeader } from './CoverageHeader';
import { CumulativeReturnChart } from './CumulativeReturnChart';
import { ReliabilityChart } from './ReliabilityChart';
import { ReturnDistributionChart } from './ReturnDistributionChart';
import { TierExpectancyChart } from './TierExpectancyChart';
import { TierTable } from './TierTable';

const STYLES: TradingStyle[] = ['scalping', 'day_trading', 'swing_trading', 'position_trading'];

const STYLE_LABELS: Record<TradingStyle, string> = {
  scalping: 'Scalping',
  day_trading: 'Day trading',
  swing_trading: 'Swing trading',
  position_trading: 'Position trading',
};

export function CalibrationDashboard() {
  // day_trading at 1h is the default because it is the pair the paper-desk
  // decision turns on, not because it is first alphabetically.
  const [style, setStyle] = useState<TradingStyle>('day_trading');
  const [interval, setIntervalValue] = useState('1h');
  const [source, setSource] = useState<'composite' | 'llm'>('composite');
  const [symbol, setSymbol] = useState<string>('');
  const [configVersion, setConfigVersion] = useState<string>('');
  const [overlapping, setOverlapping] = useState(false);

  const intervals = STYLE_CONFIGS[style].preferredIntervals;

  const { data, isLoading, error } = useCalibration({
    style,
    interval,
    source,
    symbol: symbol || undefined,
    configVersion: configVersion === '' ? undefined : Number(configVersion),
    overlapping,
  });

  function handleStyleChange(next: TradingStyle) {
    setStyle(next);
    const nextIntervals = STYLE_CONFIGS[next].preferredIntervals;
    if (!nextIntervals.includes(interval)) setIntervalValue(nextIntervals[0]);
  }

  const selectClass =
    'h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" data-testid="calibration-filters">
        <label className="sr-only" htmlFor="calibration-style">Trading style</label>
        <select
          id="calibration-style"
          className={selectClass}
          value={style}
          onChange={(e) => handleStyleChange(e.target.value as TradingStyle)}
          data-testid="style-select"
        >
          {STYLES.map((value) => (
            <option key={value} value={value}>{STYLE_LABELS[value]}</option>
          ))}
        </select>

        <label className="sr-only" htmlFor="calibration-interval">Interval</label>
        <select
          id="calibration-interval"
          className={selectClass}
          value={interval}
          onChange={(e) => setIntervalValue(e.target.value)}
          data-testid="interval-select"
        >
          {intervals.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>

        <label className="sr-only" htmlFor="calibration-source">Source</label>
        <select
          id="calibration-source"
          className={selectClass}
          value={source}
          onChange={(e) => setSource(e.target.value as 'composite' | 'llm')}
          data-testid="source-select"
        >
          <option value="composite">Composite score</option>
          <option value="llm">LLM panel</option>
        </select>

        <label className="sr-only" htmlFor="calibration-symbol">Symbol</label>
        <select
          id="calibration-symbol"
          className={selectClass}
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          data-testid="symbol-select"
        >
          <option value="">All symbols</option>
          {SIGNAL_SYMBOLS.map((value) => (
            <option key={value} value={value}>{value.replace('USDT', '')}</option>
          ))}
        </select>

        <label className="sr-only" htmlFor="calibration-version">Config version</label>
        <select
          id="calibration-version"
          className={selectClass}
          value={configVersion}
          onChange={(e) => setConfigVersion(e.target.value)}
          data-testid="config-version-select"
        >
          <option value="">All versions</option>
          {(data?.meta.configVersions ?? []).map((value) => (
            <option key={value} value={String(value)}>configVersion {value}</option>
          ))}
        </select>

        <Button
          variant={overlapping ? 'default' : 'outline'}
          size="xs"
          onClick={() => setOverlapping((prev) => !prev)}
          data-testid="overlapping-toggle"
        >
          {overlapping ? 'Overlapping' : 'Non-overlapping'}
        </Button>
      </div>

      {error ? (
        <p className="py-8 text-center text-sm text-bearish" data-testid="calibration-error">
          Could not load the calibration record.
        </p>
      ) : isLoading || !data ? (
        <div className="space-y-2" data-testid="calibration-loading">
          <div className="h-20 animate-pulse rounded bg-muted" />
          <div className="h-64 animate-pulse rounded bg-muted" />
        </div>
      ) : (
        <>
          <CoverageHeader meta={data.meta} />

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Net expectancy by tier</CardTitle>
            </CardHeader>
            <CardContent>
              <TierExpectancyChart tiers={data.tiers} costPercent={data.meta.costPercentRoundTrip} />
              <div className="mt-4">
                <TierTable tiers={data.tiers} minSamples={data.meta.minSamplesForEstimate} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Is the score monotone?</CardTitle>
            </CardHeader>
            <CardContent>
              <ReliabilityChart points={data.reliability} buyCutoff={TIER_BUY_CUTOFF} />
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Forward-return distribution</CardTitle>
              </CardHeader>
              <CardContent>
                <ReturnDistributionChart
                  distribution={data.distribution}
                  costPercent={data.meta.costPercentRoundTrip}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Cumulative net return by scorer</CardTitle>
              </CardHeader>
              <CardContent>
                <CumulativeReturnChart
                  series={data.cumulative}
                  overlapping={data.meta.overlapping}
                  horizonBars={data.meta.horizonBars}
                />
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
