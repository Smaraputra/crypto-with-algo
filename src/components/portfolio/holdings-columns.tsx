'use client';

import { type ColumnDef } from '@tanstack/react-table';
import { ArrowUpDown, FileText, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Holding } from '@/types/portfolio';
import type { Ticker24h } from '@/types/market';

export interface HoldingRow extends Holding {
  currentPrice: number | null;
  pnl: number | null;
  pnlPercent: number | null;
  allocation: number;
}

export function createHoldingColumns(options: {
  onRecordTransaction: (symbol: string) => void;
  onRemoveHolding: (symbol: string) => void;
}): ColumnDef<HoldingRow>[] {
  return [
    {
      accessorKey: 'symbol',
      header: ({ column }) => (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-3 h-8"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
        >
          Symbol
          <ArrowUpDown className="ml-1 size-3" />
        </Button>
      ),
      cell: ({ row }) => (
        <div>
          <span className="font-semibold">{row.original.baseAsset}</span>
          <span className="text-muted-foreground">/{row.original.quoteAsset}</span>
        </div>
      ),
    },
    {
      accessorKey: 'quantity',
      header: 'Quantity',
      cell: ({ row }) => (
        <span className="font-mono tabular-nums">
          {row.original.quantity.toFixed(8).replace(/\.?0+$/, '')}
        </span>
      ),
    },
    {
      accessorKey: 'avgBuyPrice',
      header: 'Avg Buy',
      cell: ({ row }) => (
        <span className="font-mono tabular-nums">
          ${row.original.avgBuyPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      ),
    },
    {
      accessorKey: 'currentPrice',
      header: 'Current',
      cell: ({ row }) => (
        <span className="font-mono tabular-nums">
          {row.original.currentPrice !== null
            ? `$${row.original.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : '--'}
        </span>
      ),
    },
    {
      accessorKey: 'pnl',
      header: ({ column }) => (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-3 h-8"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
        >
          P&L ($)
          <ArrowUpDown className="ml-1 size-3" />
        </Button>
      ),
      cell: ({ row }) => {
        const pnl = row.original.pnl;
        if (pnl === null) return <span className="font-mono tabular-nums">--</span>;
        const color = pnl >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]';
        const sign = pnl >= 0 ? '+' : '';
        return (
          <span className={`font-mono tabular-nums ${color}`}>
            {sign}${Math.abs(pnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        );
      },
    },
    {
      accessorKey: 'pnlPercent',
      header: 'P&L (%)',
      cell: ({ row }) => {
        const pct = row.original.pnlPercent;
        if (pct === null) return <span className="font-mono tabular-nums">--</span>;
        const color = pct >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]';
        const sign = pct >= 0 ? '+' : '';
        return (
          <span className={`font-mono tabular-nums ${color}`}>
            {sign}{pct.toFixed(2)}%
          </span>
        );
      },
    },
    {
      accessorKey: 'allocation',
      header: ({ column }) => (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-3 h-8"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
        >
          Alloc %
          <ArrowUpDown className="ml-1 size-3" />
        </Button>
      ),
      cell: ({ row }) => (
        <span className="font-mono tabular-nums">
          {row.original.allocation.toFixed(1)}%
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            aria-label={`Record transaction for ${row.original.symbol}`}
            onClick={() => options.onRecordTransaction(row.original.symbol)}
          >
            <FileText className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-destructive hover:text-destructive"
            aria-label={`Remove ${row.original.symbol}`}
            onClick={() => options.onRemoveHolding(row.original.symbol)}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      ),
    },
  ];
}

export function buildHoldingRows(
  holdings: Holding[],
  tickers: Record<string, Ticker24h>,
  restTickers: Ticker24h[]
): HoldingRow[] {
  let totalValue = 0;

  const withPrices = holdings.map((h) => {
    const live = tickers[h.symbol];
    const rest = restTickers.find((t) => t.symbol === h.symbol);
    const ticker = live ?? rest ?? null;
    const currentPrice = ticker ? parseFloat(ticker.lastPrice) : null;
    const value = currentPrice !== null ? currentPrice * h.quantity : 0;
    totalValue += value;

    return { holding: h, currentPrice, value };
  });

  return withPrices.map(({ holding, currentPrice, value }) => {
    const pnl = currentPrice !== null
      ? (currentPrice - holding.avgBuyPrice) * holding.quantity
      : null;
    const pnlPercent = currentPrice !== null && holding.avgBuyPrice > 0
      ? ((currentPrice - holding.avgBuyPrice) / holding.avgBuyPrice) * 100
      : null;
    const allocation = totalValue > 0 ? (value / totalValue) * 100 : 0;

    return {
      ...holding,
      currentPrice,
      pnl,
      pnlPercent,
      allocation,
    };
  });
}
