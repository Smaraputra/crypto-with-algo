'use client';

import { useMemo, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { usePortfolio, useRemoveHolding } from '@/hooks/usePortfolio';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useTickers } from '@/hooks/usePrices';
import { createHoldingColumns, buildHoldingRows } from './holdings-columns';

interface HoldingsListProps {
  portfolioId: string | null;
  onRecordTransaction?: (symbol: string) => void;
}

export function HoldingsList({ portfolioId, onRecordTransaction }: HoldingsListProps) {
  const { data, isLoading } = usePortfolio(portfolioId);
  const removeHolding = useRemoveHolding(portfolioId ?? '');
  const holdings = useMemo(
    () => data?.portfolio?.holdings ?? [],
    [data]
  );
  const heldSymbols = useMemo(
    () => holdings.map((h) => h.symbol),
    [holdings]
  );
  const { tickers } = useBinanceTicker(heldSymbols);
  const { data: restTickers } = useTickers();

  const [sorting, setSorting] = useState<SortingState>([
    { id: 'allocation', desc: true },
  ]);

  const rows = useMemo(
    () => buildHoldingRows(holdings, tickers, restTickers ?? []),
    [holdings, tickers, restTickers]
  );

  const columns = useMemo(
    () =>
      createHoldingColumns({
        onRecordTransaction: (symbol) => onRecordTransaction?.(symbol),
        onRemoveHolding: (symbol) => removeHolding.mutate(symbol),
      }),
    [onRecordTransaction, removeHolding]
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (!portfolioId) return null;

  if (isLoading) {
    return (
      <div className="space-y-2" data-testid="holdings-skeleton">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-12 rounded-sm animate-shimmer" />
        ))}
      </div>
    );
  }

  if (holdings.length === 0) {
    return (
      <Card data-testid="holdings-empty">
        <CardContent className="py-8 text-center">
          <p className="text-sm text-muted-foreground">
            No holdings in this portfolio.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      {/* Desktop table */}
      <div className="hidden md:block" data-testid="holdings-table">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile card stack */}
      <div className="space-y-2 md:hidden" data-testid="holdings-cards">
        {rows.map((row) => {
          const pnlColor = (row.pnl ?? 0) >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]';
          return (
            <Card key={row.symbol}>
              <CardContent className="py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-semibold">{row.baseAsset}</span>
                    <span className="text-muted-foreground">/{row.quoteAsset}</span>
                  </div>
                  <div className="text-right">
                    <p className="font-mono tabular-nums text-sm">
                      {row.currentPrice !== null
                        ? `$${row.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : '--'}
                    </p>
                    <p className={`font-mono tabular-nums text-xs ${pnlColor}`}>
                      {row.pnlPercent !== null
                        ? `${row.pnlPercent >= 0 ? '+' : ''}${row.pnlPercent.toFixed(2)}%`
                        : '--'}
                    </p>
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    Qty: <span className="font-mono tabular-nums">{row.quantity}</span>
                  </span>
                  <span>
                    Alloc: <span className="font-mono tabular-nums">{row.allocation.toFixed(1)}%</span>
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
