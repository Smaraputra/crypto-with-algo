'use client';

import React, { useState } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts';
import { Panel } from '@/components/kit/Panel';
import { SegmentedControl } from '@/components/kit/SegmentedControl';
import { StateNotice } from '@/components/kit/StateNotice';
import { Button } from '@/components/ui/button';
import {
  usePortfolioHistory,
  useCostBasis,
  useRiskMetrics,
  useExportCsv,
} from '@/hooks/useAnalytics';
import { useChartTheme } from '@/lib/chart-theme';
import { cn } from '@/lib/utils';
import type { CostBasisMethod, CsvFormat } from '@/types/analytics';

export interface PerformanceViewProps {
  portfolioId: string;
  className?: string;
}

function formatCurrency(val: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
}

export const PerformanceView: React.FC<PerformanceViewProps> = ({
  portfolioId,
  className,
}) => {
  const chartTheme = useChartTheme();

  // 1. History state
  const [range, setRange] = useState<'7' | '30' | '90' | '365'>('30');
  const {
    data: historyData,
    isLoading: isHistoryLoading,
    isError: isHistoryError,
    refetch: refetchHistory,
  } = usePortfolioHistory(portfolioId, Number(range));

  // 2. Cost basis state
  const [method, setMethod] = useState<CostBasisMethod>('fifo');
  const {
    data: costBasisData,
    isLoading: isCostBasisLoading,
    isError: isCostBasisError,
    refetch: refetchCostBasis,
  } = useCostBasis(portfolioId, method);

  // 3. Risk metrics state
  const {
    data: riskData,
    isLoading: isRiskLoading,
    isError: isRiskError,
    refetch: refetchRisk,
  } = useRiskMetrics(portfolioId, 90);

  // 4. Export CSV state
  const [exportFormat, setExportFormat] = useState<CsvFormat>('generic');
  const [exportError, setExportError] = useState<string | null>(null);
  const exportMutation = useExportCsv(portfolioId);

  const handleExport = async () => {
    setExportError(null);
    try {
      await exportMutation.mutateAsync({ format: exportFormat });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Export failed. Please try again.';
      setExportError(message);
    }
  };

  // Compute chart history values
  const historyPoints = historyData?.history || [];
  const hasHistory = historyPoints.length > 0;
  const startVal = hasHistory ? historyPoints[0].totalValue : 0;
  const endVal = hasHistory ? historyPoints[historyPoints.length - 1].totalValue : 0;
  const changeVal = endVal - startVal;
  const changePercent = startVal > 0 ? (changeVal / startVal) * 100 : 0;
  const lineColor = changeVal >= 0 ? chartTheme.up : chartTheme.down;

  return (
    <div className={cn('space-y-6', className)}>
      {/* 1. Value over time */}
      <Panel
        title="Value over time"
        action={
          <SegmentedControl
            legend="Range"
            value={range}
            onChange={(val) => setRange(val as '7' | '30' | '90' | '365')}
            options={[
              { value: '7', label: '7D' },
              { value: '30', label: '30D' },
              { value: '90', label: '90D' },
              { value: '365', label: '1Y' },
            ]}
          />
        }
      >
        {isHistoryLoading && (
          <StateNotice kind="loading" title="Loading value history..." />
        )}
        {isHistoryError && (
          <StateNotice
            kind="error"
            title="Failed to load history"
            action={
              <Button
                variant="outline"
                onClick={() => refetchHistory()}
                className="rounded-[12px] min-h-[44px]"
              >
                Try again
              </Button>
            }
          />
        )}
        {!isHistoryLoading && !isHistoryError && !hasHistory && (
          <StateNotice
            kind="empty"
            title="No history data for this period"
            description="Historical snapshots will appear here as portfolio values are recorded."
          />
        )}
        {!isHistoryLoading && !isHistoryError && hasHistory && (
          <div className="space-y-3">
            <div className="h-[260px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={historyPoints} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="valueFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={lineColor} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={lineColor} stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="date"
                    tick={{ fill: chartTheme.mutedText, fontSize: 12 }}
                    stroke={chartTheme.grid}
                  />
                  <YAxis
                    tick={{ fill: chartTheme.mutedText, fontSize: 12 }}
                    stroke={chartTheme.grid}
                    tickFormatter={(v) => `$${v}`}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--card)',
                      borderColor: 'var(--line)',
                      borderRadius: '8px',
                      color: 'var(--foreground)',
                      fontFamily: 'Outfit, sans-serif',
                    }}
                    formatter={(val: unknown) => [formatCurrency(Number(val)), 'Total value']}
                  />
                  <Area
                    type="monotone"
                    dataKey="totalValue"
                    stroke={lineColor}
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#valueFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p
              data-testid="history-text-alternative"
              className="text-[13px] text-muted-foreground leading-relaxed"
            >
              Starting value: {formatCurrency(startVal)}, ending value:{' '}
              {formatCurrency(endVal)}, change:{' '}
              {changeVal >= 0 ? '+' : '-'}
              {formatCurrency(Math.abs(changeVal))} (
              {changeVal >= 0 ? '+' : ''}
              {changePercent.toFixed(2)}%)
            </p>
          </div>
        )}
      </Panel>

      {/* 2. Cost basis */}
      <Panel
        title="Cost basis"
        action={
          <SegmentedControl
            legend="Method"
            value={method}
            onChange={(val) => setMethod(val as CostBasisMethod)}
            options={[
              { value: 'fifo', label: 'FIFO' },
              { value: 'lifo', label: 'LIFO' },
              { value: 'hifo', label: 'HIFO' },
            ]}
          />
        }
      >
        {isCostBasisLoading && (
          <StateNotice kind="loading" title="Loading cost basis..." />
        )}
        {isCostBasisError && (
          <StateNotice
            kind="error"
            title="Failed to load cost basis"
            action={
              <Button
                variant="outline"
                onClick={() => refetchCostBasis()}
                className="rounded-[12px] min-h-[44px]"
              >
                Try again
              </Button>
            }
          />
        )}
        {!isCostBasisLoading &&
          !isCostBasisError &&
          (!costBasisData?.costBasis?.holdings ||
            costBasisData.costBasis.holdings.length === 0) && (
            <StateNotice
              kind="empty"
              title="No cost basis data available"
              description="Record buy and sell transactions to calculate cost basis."
            />
          )}
        {!isCostBasisLoading &&
          !isCostBasisError &&
          costBasisData?.costBasis?.holdings &&
          costBasisData.costBasis.holdings.length > 0 && (
            <div className="overflow-x-auto rounded-[12px] border border-line">
              <table className="w-full text-left border-collapse">
                <caption className="sr-only">Cost basis by holding</caption>
                <thead>
                  <tr className="border-b border-line text-[13px] font-semibold text-muted-foreground bg-muted/20">
                    <th scope="col" className="py-3 px-4">
                      Coin
                    </th>
                    <th scope="col" className="py-3 px-4 text-right">
                      Cost basis
                    </th>
                    <th scope="col" className="py-3 px-4 text-right">
                      Realised P&L
                    </th>
                    <th scope="col" className="py-3 px-4 text-right">
                      Unrealised P&L
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line text-[14px]">
                  {costBasisData.costBasis.holdings.map((h) => {
                    const record = h as unknown as Record<string, unknown>;
                    const realized = h.totalRealizedGain ?? 0;
                    const unrealized = record.unrealizedPnl ?? record.unrealizedGain;

                    let realizedFormatted = `+$0.00`;
                    let realizedClass = 'text-muted-foreground';
                    if (realized > 0.0001) {
                      realizedFormatted = `+${formatCurrency(realized)}`;
                      realizedClass = 'text-up';
                    } else if (realized < -0.0001) {
                      realizedFormatted = `-${formatCurrency(Math.abs(realized))}`;
                      realizedClass = 'text-down';
                    }

                    let unrealizedFormatted = '—';
                    let unrealizedClass = 'text-muted-foreground';
                    if (typeof unrealized === 'number') {
                      if (unrealized > 0.0001) {
                        unrealizedFormatted = `+${formatCurrency(unrealized)}`;
                        unrealizedClass = 'text-up';
                      } else if (unrealized < -0.0001) {
                        unrealizedFormatted = `-${formatCurrency(Math.abs(unrealized))}`;
                        unrealizedClass = 'text-down';
                      } else {
                        unrealizedFormatted = `+$0.00`;
                      }
                    }

                    return (
                      <tr key={h.symbol} className="hover:bg-muted/30">
                        <td className="py-3 px-4 font-semibold text-foreground">
                          {h.symbol}
                        </td>
                        <td className="py-3 px-4 text-right font-sans tabular-nums text-foreground">
                          {formatCurrency(h.totalCost)}
                        </td>
                        <td
                          className={cn(
                            'py-3 px-4 text-right font-sans tabular-nums font-medium',
                            realizedClass
                          )}
                        >
                          {realizedFormatted}
                        </td>
                        <td
                          className={cn(
                            'py-3 px-4 text-right font-sans tabular-nums font-medium',
                            unrealizedClass
                          )}
                        >
                          {unrealizedFormatted}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </Panel>

      {/* 3. Risk */}
      <Panel title="Risk">
        {isRiskLoading && (
          <StateNotice kind="loading" title="Loading risk metrics..." />
        )}
        {isRiskError && (
          <StateNotice
            kind="error"
            title="Failed to load risk metrics"
            action={
              <Button
                variant="outline"
                onClick={() => refetchRisk()}
                className="rounded-[12px] min-h-[44px]"
              >
                Try again
              </Button>
            }
          />
        )}
        {!isRiskLoading &&
          !isRiskError &&
          (!riskData?.metrics || riskData.insufficientData) && (
            <StateNotice
              kind="empty"
              title="Insufficient data for risk metrics"
              description="At least 30 days of portfolio snapshots are required to compute risk metrics."
            />
          )}
        {!isRiskLoading && !isRiskError && riskData?.metrics && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-card rounded-[14px] p-4 border border-line flex flex-col justify-between gap-2">
              <span className="text-[14px] font-semibold text-foreground">
                Max drawdown
              </span>
              <span className="font-sans font-semibold text-[22px] tabular-nums text-foreground">
                {riskData.metrics.maxDrawdown !== null
                  ? `${(riskData.metrics.maxDrawdown * 100).toFixed(2)}%`
                  : '—'}
              </span>
              <p className="text-[12px] text-muted-foreground leading-normal">
                The largest fall from a peak in the period
              </p>
            </div>

            <div className="bg-card rounded-[14px] p-4 border border-line flex flex-col justify-between gap-2">
              <span className="text-[14px] font-semibold text-foreground">
                Sharpe ratio
              </span>
              <span className="font-sans font-semibold text-[22px] tabular-nums text-foreground">
                {riskData.metrics.sharpeRatio !== null
                  ? riskData.metrics.sharpeRatio.toFixed(2)
                  : '—'}
              </span>
              <p className="text-[12px] text-muted-foreground leading-normal">
                Risk-adjusted return relative to risk-free rate
              </p>
            </div>

            <div className="bg-card rounded-[14px] p-4 border border-line flex flex-col justify-between gap-2">
              <span className="text-[14px] font-semibold text-foreground">
                Sortino ratio
              </span>
              <span className="font-sans font-semibold text-[22px] tabular-nums text-foreground">
                {riskData.metrics.sortinoRatio !== null
                  ? riskData.metrics.sortinoRatio.toFixed(2)
                  : '—'}
              </span>
              <p className="text-[12px] text-muted-foreground leading-normal">
                Return adjusted for downside risk only
              </p>
            </div>

            <div className="bg-card rounded-[14px] p-4 border border-line flex flex-col justify-between gap-2">
              <span className="text-[14px] font-semibold text-foreground">
                Annualized volatility
              </span>
              <span className="font-sans font-semibold text-[22px] tabular-nums text-foreground">
                {riskData.metrics.annualizedVolatility !== null
                  ? `${(riskData.metrics.annualizedVolatility * 100).toFixed(2)}%`
                  : '—'}
              </span>
              <p className="text-[12px] text-muted-foreground leading-normal">
                Yearly variation of portfolio returns
              </p>
            </div>

            <div className="bg-card rounded-[14px] p-4 border border-line flex flex-col justify-between gap-2">
              <span className="text-[14px] font-semibold text-foreground">
                Annualized return
              </span>
              <span className="font-sans font-semibold text-[22px] tabular-nums text-foreground">
                {riskData.metrics.annualizedReturn !== null
                  ? `${(riskData.metrics.annualizedReturn * 100).toFixed(2)}%`
                  : '—'}
              </span>
              <p className="text-[12px] text-muted-foreground leading-normal">
                Geometric average return per year
              </p>
            </div>

            <div className="bg-card rounded-[14px] p-4 border border-line flex flex-col justify-between gap-2">
              <span className="text-[14px] font-semibold text-foreground">
                Total return
              </span>
              <span className="font-sans font-semibold text-[22px] tabular-nums text-foreground">
                {riskData.metrics.totalReturn !== null
                  ? `${(riskData.metrics.totalReturn * 100).toFixed(2)}%`
                  : '—'}
              </span>
              <p className="text-[12px] text-muted-foreground leading-normal">
                Overall portfolio return across the period
              </p>
            </div>

            <div className="bg-card rounded-[14px] p-4 border border-line flex flex-col justify-between gap-2">
              <span className="text-[14px] font-semibold text-foreground">
                Best day
              </span>
              <span className="font-sans font-semibold text-[22px] tabular-nums text-foreground">
                {riskData.metrics.bestDay
                  ? `${(riskData.metrics.bestDay.return * 100).toFixed(2)}%`
                  : '—'}
              </span>
              <p className="text-[12px] text-muted-foreground leading-normal">
                Largest single-day gain in the period
              </p>
            </div>

            <div className="bg-card rounded-[14px] p-4 border border-line flex flex-col justify-between gap-2">
              <span className="text-[14px] font-semibold text-foreground">
                Worst day
              </span>
              <span className="font-sans font-semibold text-[22px] tabular-nums text-foreground">
                {riskData.metrics.worstDay
                  ? `${(riskData.metrics.worstDay.return * 100).toFixed(2)}%`
                  : '—'}
              </span>
              <p className="text-[12px] text-muted-foreground leading-normal">
                Largest single-day drop in the period
              </p>
            </div>
          </div>
        )}
      </Panel>

      {/* 4. Export */}
      <Panel title="Export">
        <div className="space-y-4">
          <p className="text-[14px] text-muted-foreground max-w-xl leading-relaxed">
            Export tax and transaction reports in your accounting format of choice.
          </p>

          <div className="flex flex-col sm:flex-row items-start sm:items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="export-format"
                className="text-[14px] font-medium text-foreground"
              >
                Format
              </label>
              <select
                id="export-format"
                value={exportFormat}
                onChange={(e) => setExportFormat(e.target.value as CsvFormat)}
                className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-semibold text-[14px] focus-visible:outline-3 focus-visible:outline-ring cursor-pointer"
              >
                <option value="generic">Generic</option>
                <option value="koinly">Koinly</option>
                <option value="cointracker">CoinTracker</option>
              </select>
            </div>

            <Button
              onClick={handleExport}
              disabled={exportMutation.isPending}
              className="rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold min-h-[44px] px-5"
            >
              {exportMutation.isPending ? 'Preparing the file.' : 'Download CSV'}
            </Button>
          </div>

          {exportError && (
            <p role="alert" className="text-[13px] text-down">
              {exportError}
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
};
