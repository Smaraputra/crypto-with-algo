'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { MoreVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { StateNotice } from '@/components/kit/StateNotice';
import { TradeSheet } from './TradeSheet';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useTickers } from '@/hooks/usePrices';
import { useRemoveHolding } from '@/hooks/usePortfolio';
import { cn } from '@/lib/utils';
import type { Holding } from '@/types/portfolio';

export interface HoldingsTableProps {
  portfolioId: string;
  holdings: Holding[];
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

export const HoldingsTable: React.FC<HoldingsTableProps> = ({
  portfolioId,
  holdings,
  className,
}) => {
  const symbols = useMemo(() => holdings.map((h) => h.symbol), [holdings]);
  const { tickers: binanceTickers } = useBinanceTicker(symbols);
  const { data: restTickers } = useTickers();
  const removeHoldingMutation = useRemoveHolding(portfolioId);

  const [tradeSheetOpen, setTradeSheetOpen] = useState(false);
  const [tradeSheetMode, setTradeSheetMode] = useState<'add' | 'record'>('add');
  const [selectedHolding, setSelectedHolding] = useState<Holding | null>(null);
  const [holdingToRemove, setHoldingToRemove] = useState<Holding | null>(null);

  const handleOpenAdd = () => {
    setSelectedHolding(null);
    setTradeSheetMode('add');
    setTradeSheetOpen(true);
  };

  const handleOpenRecord = (holding: Holding) => {
    setSelectedHolding(holding);
    setTradeSheetMode('record');
    setTradeSheetOpen(true);
  };

  const handleConfirmRemove = async () => {
    if (!holdingToRemove) return;
    try {
      await removeHoldingMutation.mutateAsync(holdingToRemove.symbol);
      setHoldingToRemove(null);
    } catch {
      // error handled by hook's onError toast
    }
  };

  const computeRowData = (h: Holding) => {
    const live = binanceTickers[h.symbol]?.lastPrice;
    let priceNum: number | null = null;
    if (live) {
      const p = parseFloat(live);
      if (Number.isFinite(p)) priceNum = p;
    }
    if (priceNum === null) {
      const rest = restTickers?.find((t) => t.symbol === h.symbol)?.lastPrice;
      if (rest) {
        const p = parseFloat(rest);
        if (Number.isFinite(p)) priceNum = p;
      }
    }

    const costNum = h.quantity * h.avgBuyPrice;
    const valueNum = priceNum !== null ? h.quantity * priceNum : null;
    const pnlNum = valueNum !== null ? valueNum - costNum : null;
    const pnlPercent =
      pnlNum !== null && costNum > 0 ? (pnlNum / costNum) * 100 : 0;

    let pnlClass = 'text-muted-foreground';
    let pnlFormatted = 'n/a';
    if (pnlNum !== null) {
      if (pnlNum > 0.0001) {
        pnlClass = 'text-up';
        pnlFormatted = `+${formatCurrency(pnlNum)} (+${pnlPercent.toFixed(2)}%)`;
      } else if (pnlNum < -0.0001) {
        pnlClass = 'text-down';
        pnlFormatted = `-${formatCurrency(Math.abs(pnlNum))} (-${Math.abs(pnlPercent).toFixed(2)}%)`;
      } else {
        pnlClass = 'text-muted-foreground';
        pnlFormatted = `+${formatCurrency(0)} (+0.00%)`;
      }
    }

    return { priceNum, valueNum, costNum, pnlFormatted, pnlClass };
  };

  if (holdings.length === 0) {
    return (
      <div className={cn('space-y-4', className)}>
        <StateNotice
          kind="empty"
          title="No holdings yet. Add your first coin."
          action={
            <Button
              onClick={handleOpenAdd}
              className="rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold min-h-[44px] px-5"
            >
              Add a holding
            </Button>
          }
        />
        <TradeSheet
          open={tradeSheetOpen}
          onOpenChange={setTradeSheetOpen}
          portfolioId={portfolioId}
          mode={tradeSheetMode}
          initialHolding={selectedHolding}
        />
      </div>
    );
  }

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex items-center justify-between">
        <h2 className="text-[18px] font-semibold text-foreground">Holdings</h2>
        <Button
          onClick={handleOpenAdd}
          className="rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold min-h-[44px] px-5"
        >
          Add a holding
        </Button>
      </div>

      {/* Desktop real table */}
      <div className="hidden md:block overflow-x-auto rounded-[14px] border border-line bg-card">
        <table className="w-full text-left border-collapse">
          <caption className="sr-only">Portfolio holdings</caption>
          <thead>
            <tr className="border-b border-line text-[13px] font-semibold text-muted-foreground">
              <th scope="col" className="py-3.5 px-4">
                Coin
              </th>
              <th scope="col" className="py-3.5 px-4 text-right">
                Quantity
              </th>
              <th scope="col" className="py-3.5 px-4 text-right">
                Average cost
              </th>
              <th scope="col" className="py-3.5 px-4 text-right">
                Price
              </th>
              <th scope="col" className="py-3.5 px-4 text-right">
                Value
              </th>
              <th scope="col" className="py-3.5 px-4 text-right">
                P&L
              </th>
              <th scope="col" className="py-3.5 px-4 text-center w-12">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line text-[14px]">
            {holdings.map((h) => {
              const { priceNum, valueNum, pnlFormatted, pnlClass } =
                computeRowData(h);
              return (
                <tr key={h.symbol} className="hover:bg-muted/40 transition-colors">
                  <td className="py-3.5 px-4 font-semibold">
                    <Link
                      href={`/focus?symbol=${h.symbol}`}
                      className="text-foreground hover:underline focus-visible:outline-3 focus-visible:outline-ring rounded-xs"
                    >
                      {h.baseAsset}
                    </Link>
                  </td>
                  <td className="py-3.5 px-4 text-right font-sans tabular-nums text-foreground">
                    {h.quantity}
                  </td>
                  <td className="py-3.5 px-4 text-right font-sans tabular-nums text-foreground">
                    {formatCurrency(h.avgBuyPrice)}
                  </td>
                  <td className="py-3.5 px-4 text-right font-sans tabular-nums text-foreground">
                    {priceNum !== null ? formatCurrency(priceNum) : 'n/a'}
                  </td>
                  <td className="py-3.5 px-4 text-right font-sans tabular-nums text-foreground">
                    {valueNum !== null ? formatCurrency(valueNum) : 'n/a'}
                  </td>
                  <td
                    className={cn(
                      'py-3.5 px-4 text-right font-sans tabular-nums font-medium',
                      pnlClass
                    )}
                  >
                    {pnlFormatted}
                  </td>
                  <td className="py-3.5 px-4 text-center">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="min-h-[44px] min-w-[44px] rounded-[10px]"
                          aria-label={`Actions for ${h.baseAsset}`}
                        >
                          <MoreVertical className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem onClick={() => handleOpenRecord(h)}>
                          Record a trade
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-down focus:text-down"
                          onClick={() => setHoldingToRemove(h)}
                        >
                          Remove holding
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Phone stacked rows, each a labelled list */}
      <div className="md:hidden space-y-3">
        {holdings.map((h) => {
          const { priceNum, valueNum, pnlFormatted, pnlClass } =
            computeRowData(h);
          return (
            <div
              key={h.symbol}
              data-testid={`mobile-row-${h.symbol}`}
              className="bg-card rounded-[14px] p-4 border border-line flex flex-col gap-3"
            >
              <div className="flex items-center justify-between">
                <Link
                  href={`/focus?symbol=${h.symbol}`}
                  className="text-[16px] font-semibold text-foreground hover:underline focus-visible:outline-3 focus-visible:outline-ring rounded-xs"
                >
                  {h.baseAsset}
                </Link>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="min-h-[44px] min-w-[44px] rounded-[10px]"
                      aria-label={`Actions for ${h.baseAsset}`}
                    >
                      <MoreVertical className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuItem onClick={() => handleOpenRecord(h)}>
                      Record a trade
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-down focus:text-down"
                      onClick={() => setHoldingToRemove(h)}
                    >
                      Remove holding
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <dl className="grid grid-cols-2 gap-2 text-[14px]">
                <div>
                  <dt className="text-muted-foreground text-[12px]">Quantity</dt>
                  <dd className="font-sans tabular-nums font-medium text-foreground">
                    {h.quantity}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-[12px]">
                    Average cost
                  </dt>
                  <dd className="font-sans tabular-nums font-medium text-foreground">
                    {formatCurrency(h.avgBuyPrice)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-[12px]">Price</dt>
                  <dd className="font-sans tabular-nums font-medium text-foreground">
                    {priceNum !== null ? formatCurrency(priceNum) : 'n/a'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-[12px]">Value</dt>
                  <dd className="font-sans tabular-nums font-medium text-foreground">
                    {valueNum !== null ? formatCurrency(valueNum) : 'n/a'}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-muted-foreground text-[12px]">P&L</dt>
                  <dd className={cn('font-sans tabular-nums font-medium', pnlClass)}>
                    {pnlFormatted}
                  </dd>
                </div>
              </dl>
            </div>
          );
        })}
      </div>

      {/* Remove confirmation dialog */}
      <Dialog
        open={!!holdingToRemove}
        onOpenChange={(open) => !open && setHoldingToRemove(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove holding</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove {holdingToRemove?.baseAsset} from this
              portfolio? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-row justify-end gap-3 mt-4">
            <Button
              variant="outline"
              onClick={() => setHoldingToRemove(null)}
              className="rounded-[12px] min-h-[44px] px-4"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={removeHoldingMutation.isPending}
              onClick={handleConfirmRemove}
              className="rounded-[12px] min-h-[44px] px-4"
            >
              {removeHoldingMutation.isPending ? 'Removing...' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TradeSheet
        open={tradeSheetOpen}
        onOpenChange={setTradeSheetOpen}
        portfolioId={portfolioId}
        mode={tradeSheetMode}
        initialHolding={selectedHolding}
      />
    </div>
  );
};
