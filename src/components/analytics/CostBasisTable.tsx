'use client';

import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCostBasis } from '@/hooks/useAnalytics';
import type { CostBasisHolding } from '@/types/analytics';

interface CostBasisTableProps {
  portfolioId: string | null;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatQuantity(value: number): string {
  return value.toFixed(value < 1 ? 8 : 4);
}

export function CostBasisTable({ portfolioId }: CostBasisTableProps) {
  const { data, isLoading } = useCostBasis(portfolioId);
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);

  if (isLoading) {
    return (
      <Card data-testid="cost-basis-skeleton">
        <CardContent className="py-8">
          <div className="h-40 animate-shimmer rounded-sm" />
        </CardContent>
      </Card>
    );
  }

  const holdings = data?.costBasis.holdings ?? [];

  if (holdings.length === 0) {
    return (
      <Card data-testid="cost-basis-empty">
        <CardContent className="py-8 text-center">
          <p className="text-sm text-muted-foreground">
            No holdings to analyze. Add transactions to see cost basis data.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="cost-basis-table">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Cost Basis (FIFO)</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="pb-2 pr-4" />
                <th className="pb-2 pr-4">Asset</th>
                <th className="pb-2 pr-4 text-right">Qty Held</th>
                <th className="pb-2 pr-4 text-right">FIFO Avg Cost</th>
                <th className="pb-2 pr-4 text-right">Total Cost</th>
                <th className="pb-2 pr-4 text-right">Realized P&L</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((h: CostBasisHolding) => (
                <HoldingRow
                  key={h.symbol}
                  holding={h}
                  expanded={expandedSymbol === h.symbol}
                  onToggle={() =>
                    setExpandedSymbol(expandedSymbol === h.symbol ? null : h.symbol)
                  }
                />
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-medium">
                <td />
                <td className="pt-2">Total</td>
                <td />
                <td />
                <td className="pt-2 text-right font-mono tabular-nums">
                  {formatCurrency(data?.costBasis.totalUnrealizedCostBasis ?? 0)}
                </td>
                <td
                  className={`pt-2 text-right font-mono tabular-nums ${
                    (data?.costBasis.totalRealizedGain ?? 0) >= 0
                      ? 'text-[#0ecb81]'
                      : 'text-[#f6465d]'
                  }`}
                >
                  {formatCurrency(data?.costBasis.totalRealizedGain ?? 0)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function HoldingRow({
  holding,
  expanded,
  onToggle,
}: {
  holding: CostBasisHolding;
  expanded: boolean;
  onToggle: () => void;
}) {
  const ChevronIcon = expanded ? ChevronDown : ChevronRight;

  return (
    <>
      <tr
        className="cursor-pointer border-b border-border/50 hover:bg-muted/30"
        onClick={onToggle}
        data-testid={`row-${holding.symbol}`}
      >
        <td className="py-2 pr-2">
          <ChevronIcon className="h-3 w-3 text-muted-foreground" />
        </td>
        <td className="py-2 pr-4 font-medium">{holding.symbol.replace('USDT', '')}</td>
        <td className="py-2 pr-4 text-right font-mono tabular-nums">
          {formatQuantity(holding.totalQuantity)}
        </td>
        <td className="py-2 pr-4 text-right font-mono tabular-nums">
          {formatCurrency(holding.averageCost)}
        </td>
        <td className="py-2 pr-4 text-right font-mono tabular-nums">
          {formatCurrency(holding.totalCost)}
        </td>
        <td
          className={`py-2 text-right font-mono tabular-nums ${
            holding.totalRealizedGain >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'
          }`}
        >
          {formatCurrency(holding.totalRealizedGain)}
        </td>
      </tr>
      {expanded && holding.openLots.length > 0 && (
        <tr>
          <td colSpan={6} className="bg-muted/20 px-4 py-2">
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Open Tax Lots
            </p>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="pb-1 text-left">Buy Date</th>
                  <th className="pb-1 text-right">Qty Remaining</th>
                  <th className="pb-1 text-right">Cost/Unit</th>
                  <th className="pb-1 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {holding.openLots.map((lot, i) => (
                  <tr key={i}>
                    <td className="py-0.5">
                      {new Date(lot.date).toLocaleDateString()}
                    </td>
                    <td className="py-0.5 text-right font-mono tabular-nums">
                      {formatQuantity(lot.remainingQuantity)}
                    </td>
                    <td className="py-0.5 text-right font-mono tabular-nums">
                      {formatCurrency(lot.pricePerUnit)}
                    </td>
                    <td className="py-0.5 text-right font-mono tabular-nums">
                      {formatCurrency(lot.remainingQuantity * lot.pricePerUnit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
