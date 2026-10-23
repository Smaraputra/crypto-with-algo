'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts';
import type { BacktestResult, ExitReason } from '@/lib/backtest/types';
import { SESSION_LABELS } from '@/lib/sessions';
import { useSaveBacktestResult } from '@/hooks/useBacktestResults';
import { useChartTheme } from '@/lib/chart-theme';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ResultsViewProps {
  result: BacktestResult | null;
  error?: string | null;
  selectedStrategyId?: string | null;
  isSavedResult?: boolean;
  className?: string;
}

const EXIT_REASON_LABELS: Record<ExitReason, string> = {
  signal: 'Signal',
  stop_loss: 'Stop loss',
  take_profit: 'Take profit',
  end_of_data: 'End of data',
  time_stop: 'Time stop',
  epoch_end: 'Epoch end',
};

function formatCurrency(val: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
}

function formatSignedCurrency(val: number, pct?: number): {
  text: string;
  className: string;
} {
  const isPositive = val > 0.0001;
  const isNegative = val < -0.0001;
  const sign = isPositive ? '+' : isNegative ? '-' : '';
  const formattedVal = `${sign}${formatCurrency(Math.abs(val))}`;
  const color = isPositive ? 'text-up' : isNegative ? 'text-down' : 'text-foreground';

  if (pct !== undefined) {
    const absPct = Math.abs(pct);
    return {
      text: `${formattedVal} (${sign}${absPct.toFixed(2)}%)`,
      className: color,
    };
  }
  return {
    text: formattedVal,
    className: color,
  };
}

function formatTradeTimestamp(timestampMs: number): string {
  const d = new Date(timestampMs);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

export const ResultsView: React.FC<ResultsViewProps> = ({
  result,
  error,
  selectedStrategyId,
  isSavedResult = false,
  className,
}) => {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const chartTheme = useChartTheme();
  const saveMutation = useSaveBacktestResult();

  const [tradePage, setTradePage] = useState(1);
  const [prevResult, setPrevResult] = useState(result);
  if (result !== prevResult) {
    setPrevResult(result);
    setTradePage(1);
  }

  // Focus results heading on new result
  useEffect(() => {
    if (result) {
      headingRef.current?.focus();
    }
  }, [result]);

  if (error) {
    return (
      <div className={cn('bg-card rounded-panel p-6 border border-line space-y-3', className)}>
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-[20px] font-semibold text-foreground outline-none"
        >
          Results
        </h2>
        <div role="alert" className="p-4 rounded-[12px] bg-muted/40 border border-edge text-[14px] text-down">
          Backtest failed: {error}
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className={cn('bg-card rounded-panel p-6 sm:p-8 border border-line space-y-3 text-center sm:text-left', className)}>
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-[20px] font-semibold text-foreground outline-none"
        >
          Results
        </h2>
        <p className="text-[14px] text-muted-foreground leading-relaxed max-w-md">
          Configure a strategy and click &quot;Run backtest&quot; to test performance on historical data.
        </p>
      </div>
    );
  }

  const { metrics, trades, equityCurve, config, symbol, interval } = result;
  const isZeroTrades = metrics.totalTrades === 0;

  const handleSaveResult = () => {
    saveMutation.mutate({
      strategyId: selectedStrategyId ?? undefined,
      symbol: result.symbol,
      interval: result.interval,
      config: result.config as unknown as Record<string, unknown>,
      metrics: result.metrics as unknown as Record<string, unknown>,
      trades: result.trades as unknown as Record<string, unknown>[],
      equityCurve: result.equityCurve as unknown as Record<string, unknown>[],
      totalBars: result.totalBars,
      warmupBars: result.warmupBars,
      startTime: result.startTime,
      endTime: result.endTime,
    });
  };

  // Equity calculations
  const startEquity = equityCurve.length > 0 ? equityCurve[0].equity : config.startEquity;
  const endEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : config.startEquity;
  const equityChange = endEquity - startEquity;
  const lineColor = equityChange >= 0 ? chartTheme.up : chartTheme.down;

  // Pagination for trades
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(trades.length / pageSize));
  const displayedTrades = trades.slice((tradePage - 1) * pageSize, tradePage * pageSize);

  const totalPnlFormatted = formatSignedCurrency(metrics.totalPnl, metrics.totalPnlPercent);

  return (
    <div className={cn('space-y-6', className)}>
      {/* Header and Save button */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-[22px] font-semibold text-foreground outline-none tracking-[-0.01em]"
          >
            Results
          </h2>
          <p className="text-[13px] text-muted-foreground font-sans tabular-nums mt-0.5">
            {symbol} on {interval} • {metrics.totalTrades} trades
          </p>
          {isZeroTrades && (
            <p className="text-[13px] text-muted-foreground mt-1">
              No trades were taken in this run.
            </p>
          )}
        </div>

        {isSavedResult ? (
          <span className="text-[14px] font-semibold text-muted-foreground px-4 py-2 rounded-[12px] border border-line bg-muted/20 self-start sm:self-auto">
            Saved result
          </span>
        ) : (
          <Button
            type="button"
            onClick={handleSaveResult}
            disabled={saveMutation.isPending}
            className="min-h-[44px] rounded-[12px] font-semibold text-[14px] px-5"
          >
            {saveMutation.isPending ? 'Saving...' : 'Save this result'}
          </Button>
        )}
      </div>

      {/* 1. Metrics Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3.5">
        {/* Total P&L */}
        <div className="bg-card rounded-[14px] p-4 border border-line flex flex-col justify-between gap-2">
          <span className="text-[13px] font-semibold text-muted-foreground">
            Total P&L
          </span>
          <span
            data-testid="metric-total-pnl"
            className={cn(
              'font-sans font-semibold text-[22px] tabular-nums',
              isZeroTrades ? 'text-muted-foreground' : totalPnlFormatted.className
            )}
          >
            {isZeroTrades ? 'n/a' : totalPnlFormatted.text}
          </span>
          <span className="text-[12px] text-muted-foreground">
            Net return across the backtest period
          </span>
        </div>

        {/* Win rate */}
        <div className="bg-card rounded-[14px] p-4 border border-line flex flex-col justify-between gap-2">
          <span className="text-[13px] font-semibold text-muted-foreground">
            Win rate
          </span>
          <span
            data-testid="metric-win-rate"
            className={cn(
              'font-sans font-semibold text-[22px] tabular-nums',
              isZeroTrades ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {isZeroTrades ? 'n/a' : `${(metrics.winRate * 100).toFixed(1)}%`}
          </span>
          <span className="text-[12px] text-muted-foreground">
            {isZeroTrades ? 'n/a' : `${metrics.winningTrades} wins, ${metrics.losingTrades} losses`}
          </span>
        </div>

        {/* Profit factor */}
        <div className="bg-card rounded-[14px] p-4 border border-line flex flex-col justify-between gap-2">
          <span className="text-[13px] font-semibold text-muted-foreground">
            Profit factor
          </span>
          <span
            data-testid="metric-profit-factor"
            className={cn(
              'font-sans font-semibold text-[22px] tabular-nums',
              isZeroTrades ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {isZeroTrades
              ? 'n/a'
              : metrics.profitFactor === Infinity
              ? 'Infinity'
              : metrics.profitFactor.toFixed(2)}
          </span>
          <span className="text-[12px] text-muted-foreground">
            Gross profits divided by gross losses
          </span>
        </div>

        {/* Max drawdown */}
        <div className="bg-card rounded-[14px] p-4 border border-line flex flex-col justify-between gap-2">
          <span className="text-[13px] font-semibold text-muted-foreground">
            Max drawdown
          </span>
          <span
            data-testid="metric-max-drawdown"
            className={cn(
              'font-sans font-semibold text-[22px] tabular-nums',
              isZeroTrades ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {isZeroTrades ? 'n/a' : `${metrics.maxDrawdownPercent.toFixed(1)}%`}
          </span>
          <span className="text-[12px] text-muted-foreground">
            Peak to trough capital decline
          </span>
        </div>

        {/* Sharpe */}
        <div className="bg-card rounded-[14px] p-4 border border-line flex flex-col justify-between gap-2">
          <span className="text-[13px] font-semibold text-muted-foreground">
            Sharpe ratio
          </span>
          <span
            data-testid="metric-sharpe"
            className={cn(
              'font-sans font-semibold text-[22px] tabular-nums',
              isZeroTrades ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {isZeroTrades ? 'n/a' : metrics.sharpeRatio.toFixed(2)}
          </span>
          <span className="text-[12px] text-muted-foreground">
            Risk-adjusted return relative to risk-free rate
          </span>
        </div>

        {/* Expectancy per trade */}
        <div className="bg-card rounded-[14px] p-4 border border-line flex flex-col justify-between gap-2">
          <span className="text-[13px] font-semibold text-muted-foreground">
            Expectancy per trade
          </span>
          <span
            data-testid="metric-expectancy"
            className={cn(
              'font-sans font-semibold text-[22px] tabular-nums',
              isZeroTrades
                ? 'text-muted-foreground'
                : metrics.expectancyPercent > 0.0001
                ? 'text-up'
                : metrics.expectancyPercent < -0.0001
                ? 'text-down'
                : 'text-foreground'
            )}
          >
            {isZeroTrades
              ? 'n/a'
              : `${metrics.expectancyPercent > 0.0001 ? '+' : ''}${metrics.expectancyPercent.toFixed(2)}%`}
          </span>
          <span className="text-[12px] text-muted-foreground">
            Average return expected on each trade
          </span>
        </div>

        {/* Total fees */}
        <div className="bg-card rounded-[14px] p-4 border border-line flex flex-col justify-between gap-2">
          <span className="text-[13px] font-semibold text-muted-foreground">
            Total fees
          </span>
          <span
            data-testid="metric-total-fees"
            className={cn(
              'font-sans font-semibold text-[22px] tabular-nums',
              isZeroTrades ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {isZeroTrades ? 'n/a' : formatCurrency(metrics.totalFees)}
          </span>
          <span className="text-[12px] text-muted-foreground">
            Transaction costs deducted
          </span>
        </div>

        {/* Total trades */}
        <div className="bg-card rounded-[14px] p-4 border border-line flex flex-col justify-between gap-2">
          <span className="text-[13px] font-semibold text-muted-foreground">
            Total trades
          </span>
          <span
            data-testid="metric-total-trades"
            className="font-sans font-semibold text-[22px] tabular-nums text-foreground"
          >
            {metrics.totalTrades}
          </span>
          <span className="text-[12px] text-muted-foreground">
            Completed trade rounds
          </span>
        </div>
      </div>

      {/* 2. Equity Curve */}
      <div className="bg-card rounded-panel p-5 sm:p-6 border border-line space-y-4">
        <h3 className="text-[16px] font-semibold text-foreground">
          Equity curve
        </h3>

        {equityCurve.length > 0 ? (
          <div className="space-y-3">
            <div className="h-[280px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={equityCurve} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={lineColor} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={lineColor} stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="bar"
                    tick={{ fill: chartTheme.mutedText, fontSize: 12 }}
                    stroke={chartTheme.grid}
                  />
                  <YAxis
                    tick={{ fill: chartTheme.mutedText, fontSize: 12 }}
                    stroke={chartTheme.grid}
                    tickFormatter={(v) => `$${v.toLocaleString()}`}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--card)',
                      borderColor: 'var(--line)',
                      borderRadius: '8px',
                      color: 'var(--foreground)',
                      fontFamily: 'Outfit, sans-serif',
                    }}
                    formatter={(val: unknown) => [formatCurrency(Number(val)), 'Equity']}
                  />
                  <Area
                    type="monotone"
                    dataKey="equity"
                    stroke={lineColor}
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#equityFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p
              data-testid="equity-text-alternative"
              className="text-[13px] text-muted-foreground leading-relaxed font-sans tabular-nums"
            >
              Starting equity: {formatCurrency(startEquity)}, ending equity: {formatCurrency(endEquity)}
            </p>
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">No equity points recorded.</p>
        )}
      </div>

      {/* 3. Session Breakdown (when present) */}
      {metrics.sessionBreakdown && metrics.sessionBreakdown.length > 0 && (
        <div className="bg-card rounded-panel p-5 sm:p-6 border border-line space-y-3">
          <h3 className="text-[16px] font-semibold text-foreground">
            Session breakdown
          </h3>
          <div className="overflow-x-auto rounded-[12px] border border-line">
            <table className="w-full text-left border-collapse">
              <caption className="sr-only">Performance by market session</caption>
              <thead>
                <tr className="border-b border-line text-[13px] font-semibold text-muted-foreground bg-muted/20">
                  <th scope="col" className="py-2.5 px-3">Session</th>
                  <th scope="col" className="py-2.5 px-3 text-right">Trades</th>
                  <th scope="col" className="py-2.5 px-3 text-right">Wins</th>
                  <th scope="col" className="py-2.5 px-3 text-right">Win rate</th>
                  <th scope="col" className="py-2.5 px-3 text-right">Total P&L</th>
                  <th scope="col" className="py-2.5 px-3 text-right">Avg P&L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-[13px]">
                {metrics.sessionBreakdown.map((row) => {
                  const pnlFormatted = formatSignedCurrency(row.totalPnl);
                  return (
                    <tr key={row.session} className="hover:bg-muted/30">
                      <td className="py-2.5 px-3 font-semibold text-foreground">
                        {SESSION_LABELS[row.session] ?? row.session}
                      </td>
                      <td className="py-2.5 px-3 text-right font-sans tabular-nums text-foreground">
                        {row.trades}
                      </td>
                      <td className="py-2.5 px-3 text-right font-sans tabular-nums text-foreground">
                        {row.wins}
                      </td>
                      <td className="py-2.5 px-3 text-right font-sans tabular-nums text-foreground">
                        {(row.winRate * 100).toFixed(1)}%
                      </td>
                      <td className={cn('py-2.5 px-3 text-right font-sans tabular-nums font-semibold', pnlFormatted.className)}>
                        {pnlFormatted.text}
                      </td>
                      <td
                        className={cn(
                          'py-2.5 px-3 text-right font-sans tabular-nums font-semibold',
                          row.avgPnlPercent > 0.0001
                            ? 'text-up'
                            : row.avgPnlPercent < -0.0001
                            ? 'text-down'
                            : 'text-foreground'
                        )}
                      >
                        {row.avgPnlPercent > 0.0001 ? '+' : ''}
                        {row.avgPnlPercent.toFixed(2)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 4. Trades Table */}
      <div className="bg-card rounded-panel p-5 sm:p-6 border border-line space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-[16px] font-semibold text-foreground">
            Trades ({trades.length})
          </h3>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setTradePage((p) => Math.max(1, p - 1))}
                disabled={tradePage === 1}
                className="min-h-[44px] rounded-[10px] text-[13px] px-3 font-medium"
              >
                Previous
              </Button>
              <span className="text-[13px] text-muted-foreground font-sans tabular-nums px-2">
                Page {tradePage} of {totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setTradePage((p) => Math.min(totalPages, p + 1))}
                disabled={tradePage === totalPages}
                className="min-h-[44px] rounded-[10px] text-[13px] px-3 font-medium"
              >
                Next
              </Button>
            </div>
          )}
        </div>

        {trades.length > 0 ? (
          <div className="overflow-x-auto rounded-[12px] border border-line">
            <table className="w-full text-left border-collapse">
              <caption className="sr-only">Detailed trade log</caption>
              <thead>
                <tr className="border-b border-line text-[13px] font-semibold text-muted-foreground bg-muted/20">
                  <th scope="col" className="py-2.5 px-3">Entry time</th>
                  <th scope="col" className="py-2.5 px-3">Exit time</th>
                  <th scope="col" className="py-2.5 px-3">Side</th>
                  <th scope="col" className="py-2.5 px-3 text-right">Entry price</th>
                  <th scope="col" className="py-2.5 px-3 text-right">Exit price</th>
                  <th scope="col" className="py-2.5 px-3 text-right">P&L</th>
                  <th scope="col" className="py-2.5 px-3">Exit reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-[13px]">
                {displayedTrades.map((t) => {
                  const pnlFormatted = formatSignedCurrency(t.pnl, t.pnlPercent);
                  return (
                    <tr key={`${t.entryBar}-${t.entryTime}-${t.exitTime}-${t.side}`} className="hover:bg-muted/30">
                      <td className="py-2.5 px-3 text-foreground whitespace-nowrap">
                        {formatTradeTimestamp(t.entryTime)}
                      </td>
                      <td className="py-2.5 px-3 text-foreground whitespace-nowrap">
                        {formatTradeTimestamp(t.exitTime)}
                      </td>
                      <td className="py-2.5 px-3 font-semibold text-foreground uppercase">
                        {t.side}
                      </td>
                      <td className="py-2.5 px-3 text-right font-sans tabular-nums text-foreground">
                        {formatCurrency(t.entryPrice)}
                      </td>
                      <td className="py-2.5 px-3 text-right font-sans tabular-nums text-foreground">
                        {formatCurrency(t.exitPrice)}
                      </td>
                      <td className={cn('py-2.5 px-3 text-right font-sans tabular-nums font-semibold', pnlFormatted.className)}>
                        {pnlFormatted.text}
                      </td>
                      <td className="py-2.5 px-3 text-muted-foreground">
                        {EXIT_REASON_LABELS[t.exitReason] ?? t.exitReason}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">No trades were taken in this run.</p>
        )}
      </div>
    </div>
  );
};
