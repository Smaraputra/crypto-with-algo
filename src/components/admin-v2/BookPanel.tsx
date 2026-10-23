'use client';

import React, { useMemo } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from 'recharts';
import { Panel } from '@/components/kit/Panel';
import { useChartTheme } from '@/lib/chart-theme';
import { describeReadRule } from '@/lib/paper-desk/report';
import type { PaperDeskBook } from '@/hooks/usePaperDesk';
import { cn } from '@/lib/utils';
import { bookTitle } from './labels';

export interface BookPanelProps {
  book: PaperDeskBook;
  className?: string;
}

export function formatChartTick(timeMs: number): string {
  const d = new Date(timeMs);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatChartTooltipLabel(timeMs: number): string {
  const d = new Date(timeMs);
  const dateStr = d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dateStr}, ${hours}:${minutes}`;
}

export function formatCurrency(val: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
}

export function formatEquityValue(val: number | null | undefined, trades: number): string {
  if (val === null || val === undefined || isNaN(val)) {
    return 'n/a';
  }
  if (trades === 0 && val === 0) {
    return 'n/a';
  }
  return formatCurrency(val);
}

export function formatSignedCurrency(val: number): string {
  if (Math.abs(val) < 0.0001) return '$0.00';
  const isPositive = val > 0.0001;
  const sign = isPositive ? '+' : '-';
  return `${sign}${formatCurrency(Math.abs(val))}`;
}

export function getPnlColor(val: number): string {
  if (val > 0.0001) return 'text-up';
  if (val < -0.0001) return 'text-down';
  return 'text-foreground';
}

export function formatSignedPercent(val: number | null | undefined): string {
  if (val === null || val === undefined || isNaN(val)) return 'n/a';
  if (Math.abs(val) < 0.0001) return '0.00%';
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}%`;
}

export function getPercentColor(val: number | null | undefined): string {
  if (val === null || val === undefined || isNaN(val)) return 'text-muted-foreground';
  if (val > 0.0001) return 'text-up';
  if (val < -0.0001) return 'text-down';
  return 'text-foreground';
}

export const BookPanel: React.FC<BookPanelProps> = ({ book, className }) => {
  const chartTheme = useChartTheme();

  const hasNoTrades =
    book.trades === 0 &&
    (!book.engineCurve || book.engineCurve.length === 0) &&
    (!book.executableCurve || book.executableCurve.length === 0);

  const chartData = useMemo(() => {
    const timeMap = new Map<number, { time: number; engine?: number; executable?: number }>();
    for (const pt of book.engineCurve ?? []) {
      const existing = timeMap.get(pt.time) ?? { time: pt.time };
      existing.engine = pt.equity;
      timeMap.set(pt.time, existing);
    }
    for (const pt of book.executableCurve ?? []) {
      const existing = timeMap.get(pt.time) ?? { time: pt.time };
      existing.executable = pt.equity;
      timeMap.set(pt.time, existing);
    }
    return Array.from(timeMap.values()).sort((a, b) => a.time - b.time);
  }, [book.engineCurve, book.executableCurve]);

  // Compute y-axis domain: padded 5% around the data, never starting from $0
  const { yMin, yMax } = useMemo(() => {
    const allEquities = [
      ...(book.engineCurve ?? []).map((p) => p.equity),
      ...(book.executableCurve ?? []).map((p) => p.equity),
    ];
    if (allEquities.length > 0) {
      const min = Math.min(...allEquities);
      const max = Math.max(...allEquities);
      if (min === max) {
        const pad = Math.abs(min) * 0.05 || 100;
        return {
          yMin: Math.floor(min - pad),
          yMax: Math.ceil(max + pad),
        };
      }
      const range = max - min;
      const pad = range * 0.05;
      return {
        yMin: Math.floor(min - pad),
        yMax: Math.ceil(max + pad),
      };
    }
    const pad = Math.abs(book.startEquity) * 0.05 || 100;
    return {
      yMin: Math.floor(book.startEquity - pad),
      yMax: Math.ceil(book.startEquity + pad),
    };
  }, [book.engineCurve, book.executableCurve, book.startEquity]);

  // Exits by reason sorted descending by count
  const sortedReasons = useMemo(() => {
    return Object.entries(book.byReason ?? {}).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
  }, [book.byReason]);

  return (
    <Panel title={bookTitle(book.book)} level={2} className={cn('space-y-6', className)}>
      {hasNoTrades ? (
        <p className="text-[14px] text-muted-foreground">No trades yet for this book.</p>
      ) : (
        <>
          {/* 1. Equity Chart */}
          <div className="space-y-3">
            <div className="h-[280px] w-full" data-testid="equity-chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <XAxis
                    dataKey="time"
                    type="number"
                    scale="time"
                    domain={['dataMin', 'dataMax']}
                    minTickGap={48}
                    tick={{ fill: chartTheme.mutedText, fontSize: 12 }}
                    stroke={chartTheme.grid}
                    tickFormatter={(v) => formatChartTick(Number(v))}
                  />
                  <YAxis
                    domain={[yMin, yMax]}
                    tick={{ fill: chartTheme.mutedText, fontSize: 12 }}
                    stroke={chartTheme.grid}
                    tickFormatter={(v) => `$${Number(v).toLocaleString('en-US')}`}
                  />
                  <Tooltip
                    labelFormatter={(label) => formatChartTooltipLabel(Number(label))}
                    contentStyle={{
                      backgroundColor: 'var(--card)',
                      borderColor: 'var(--line)',
                      borderRadius: '8px',
                      color: 'var(--foreground)',
                      fontFamily: 'Outfit, sans-serif',
                    }}
                    formatter={(val: unknown, name?: string | number) => [
                      val !== undefined && val !== null ? formatCurrency(Number(val)) : 'n/a',
                      String(name ?? ''),
                    ]}
                  />
                  <Legend
                    verticalAlign="top"
                    align="right"
                    wrapperStyle={{ paddingBottom: '8px', fontSize: '13px' }}
                  />
                  <Line
                    type="linear"
                    dataKey="executable"
                    name="Executable"
                    stroke={chartTheme.text}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="linear"
                    dataKey="engine"
                    name="Engine"
                    stroke={chartTheme.mutedText}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Text alternative stating start equity and the two end equities */}
            <p
              data-testid="equity-text-alternative"
              className="text-[13px] text-muted-foreground leading-relaxed font-sans tabular-nums"
            >
              Starting equity: {formatEquityValue(book.startEquity, book.trades)}, Engine ending equity: {formatEquityValue(book.equity, book.trades)}, Executable ending equity: {formatEquityValue(book.executableEquity, book.trades)}
            </p>
          </div>

          {/* 2. Key Stats Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[14px]">
              <caption className="sr-only">Key statistics for {bookTitle(book.book)}</caption>
              <thead>
                <tr className="border-b border-line text-[12px] font-semibold text-muted-foreground">
                  <th scope="col" className="py-2.5 pr-4">Metric</th>
                  <th scope="col" className="py-2.5 px-4 text-right">Engine</th>
                  <th scope="col" className="py-2.5 pl-4 text-right">Executable</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {/* Trades */}
                <tr className="h-11">
                  <td className="py-2.5 pr-4 font-semibold text-foreground">Trades</td>
                  <td className="py-2.5 px-4 text-right font-sans tabular-nums text-foreground">
                    {book.engine ? book.engine.trades.toLocaleString('en-US') : 'n/a'}
                  </td>
                  <td className="py-2.5 pl-4 text-right font-sans tabular-nums text-foreground">
                    {book.executable ? book.executable.trades.toLocaleString('en-US') : 'n/a'}
                  </td>
                </tr>

                {/* Expectancy */}
                <tr className="h-11">
                  <td className="py-2.5 pr-4 font-semibold text-foreground">Expectancy</td>
                  <td className="py-2.5 px-4 text-right font-sans tabular-nums">
                    {book.engine ? (
                      <div>
                        <span className={cn('font-semibold', getPercentColor(book.engine.expectancyPercent))}>
                          {formatSignedPercent(book.engine.expectancyPercent)}
                        </span>
                        <span className="text-[12px] text-muted-foreground ml-1.5">
                          [{formatSignedPercent(book.engine.ciLowPercent)}, {formatSignedPercent(book.engine.ciHighPercent)}]
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">n/a</span>
                    )}
                  </td>
                  <td className="py-2.5 pl-4 text-right font-sans tabular-nums">
                    {book.executable ? (
                      <div>
                        <span className={cn('font-semibold', getPercentColor(book.executable.expectancyPercent))}>
                          {formatSignedPercent(book.executable.expectancyPercent)}
                        </span>
                        <span className="text-[12px] text-muted-foreground ml-1.5">
                          [{formatSignedPercent(book.executable.ciLowPercent)}, {formatSignedPercent(book.executable.ciHighPercent)}]
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">n/a</span>
                    )}
                  </td>
                </tr>

                {/* Win rate */}
                <tr className="h-11">
                  <td className="py-2.5 pr-4 font-semibold text-foreground">Win rate</td>
                  <td className="py-2.5 px-4 text-right font-sans tabular-nums text-foreground">
                    {book.engine ? `${(book.engine.winRate * 100).toFixed(1)}%` : 'n/a'}
                  </td>
                  <td className="py-2.5 pl-4 text-right font-sans tabular-nums text-foreground">
                    {book.executable ? `${(book.executable.winRate * 100).toFixed(1)}%` : 'n/a'}
                  </td>
                </tr>

                {/* Total P&L */}
                <tr className="h-11">
                  <td className="py-2.5 pr-4 font-semibold text-foreground">Total P&L</td>
                  <td className="py-2.5 px-4 text-right font-sans tabular-nums">
                    {book.engine ? (
                      <span className={cn('font-semibold', getPnlColor(book.engine.totalPnl))}>
                        {formatSignedCurrency(book.engine.totalPnl)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">n/a</span>
                    )}
                  </td>
                  <td className="py-2.5 pl-4 text-right font-sans tabular-nums">
                    {book.executable ? (
                      <span className={cn('font-semibold', getPnlColor(book.executable.totalPnl))}>
                        {formatSignedCurrency(book.executable.totalPnl)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">n/a</span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* 3. Lag cost & Research record */}
      <div className="space-y-2 text-[14px]">
        <p className="text-muted-foreground font-sans">
          Lag cost per trade:{' '}
          <span className="font-semibold text-foreground tabular-nums">
            {book.lagCostPercent !== null && book.lagCostPercent !== undefined
              ? formatSignedPercent(book.lagCostPercent)
              : 'n/a'}
          </span>
        </p>

        <p className="text-muted-foreground font-sans">
          Research expectancy at this interval:{' '}
          <span className="font-semibold text-foreground tabular-nums">
            {formatSignedPercent(book.recordedExpectancyPercent)}
          </span>
          {book.evidenceStatus ? (
            <span className="text-muted-foreground"> (evidence {book.evidenceStatus})</span>
          ) : null}
        </p>
      </div>

      {/* 4. Read rule */}
      <div className="space-y-1">
        <h3 className="text-[14px] font-semibold text-foreground">
          Read rule (declared {book.readRule.declaredOn})
        </h3>
        <p className="text-[14px] text-muted-foreground leading-relaxed font-sans">
          {describeReadRule(book.readRule)}
        </p>
      </div>

      {/* 5. Details disclosure */}
      <details className="border-t border-line pt-4">
        <summary className="text-[14px] font-semibold text-foreground cursor-pointer select-none py-1">
          Details
        </summary>
        <div className="pt-3 space-y-4 text-[13px]">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <span className="text-muted-foreground">Symbols: </span>
              <span className="font-sans tabular-nums font-semibold text-foreground">{book.symbols}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Open positions: </span>
              <span className="font-sans tabular-nums font-semibold text-foreground">{book.openPositions}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Gapped stops: </span>
              <span className="font-sans tabular-nums font-semibold text-foreground">{book.gappedStops}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Stopped on arrival: </span>
              <span className="font-sans tabular-nums font-semibold text-foreground">{book.stoppedOnArrival}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Unfilled: </span>
              <span className="font-sans tabular-nums font-semibold text-foreground">{book.unfilled}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Missing score bars: </span>
              <span className="font-sans tabular-nums font-semibold text-foreground">{book.missingScoreBars}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Peak leverage: </span>
              <span className="font-sans tabular-nums font-semibold text-foreground">{book.peakLeverage.toFixed(2)}x</span>
            </div>
          </div>

          <div>
            <h4 className="text-[13px] font-semibold text-foreground mb-1.5">Exits by reason</h4>
            {sortedReasons.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">None</p>
            ) : (
              <ul className="space-y-1 max-w-sm" data-testid="exits-by-reason">
                {sortedReasons.map(([reason, count]) => (
                  <li key={reason} className="flex items-center justify-between py-0.5 text-[13px]">
                    <span className="text-muted-foreground">{reason}</span>
                    <span className="font-sans tabular-nums font-semibold text-foreground">{count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </details>
    </Panel>
  );
};
