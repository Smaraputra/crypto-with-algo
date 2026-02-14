'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUpdateJournalEntry } from '@/hooks/useJournal';
import type { JournalEntry } from '@/types/journal';

interface CloseTradeDialogProps {
  entry: JournalEntry;
  trigger?: React.ReactNode;
}

export function CloseTradeDialog({ entry, trigger }: CloseTradeDialogProps) {
  const [open, setOpen] = useState(false);
  const [exitPrice, setExitPrice] = useState('');
  const updateMutation = useUpdateJournalEntry();

  const exitNum = parseFloat(exitPrice);
  const hasValidExit = !isNaN(exitNum) && exitNum > 0;
  const pnlPreview =
    entry.entryPrice != null && hasValidExit
      ? entry.action === 'sell'
        ? ((entry.entryPrice - exitNum) / entry.entryPrice) * 100
        : ((exitNum - entry.entryPrice) / entry.entryPrice) * 100
      : null;

  function handleSubmit() {
    if (!hasValidExit) return;
    updateMutation.mutate(
      { id: entry._id, exitPrice: exitNum },
      {
        onSuccess: () => {
          setOpen(false);
          setExitPrice('');
        },
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button size="sm" variant="outline" className="text-xs" data-testid="close-trade-trigger">
            Close Trade
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-sm" data-testid="close-trade-dialog">
        <DialogHeader>
          <DialogTitle>Close Trade</DialogTitle>
          <DialogDescription>
            Enter the exit price for your {entry.symbol} {entry.action} trade.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {entry.entryPrice != null && (
            <div className="text-xs text-muted-foreground">
              Entry Price:{' '}
              <span className="font-mono tabular-nums">
                ${entry.entryPrice.toLocaleString()}
              </span>
            </div>
          )}

          <div className="space-y-1">
            <Label className="text-xs">Exit Price</Label>
            <Input
              type="number"
              step="any"
              min="0"
              value={exitPrice}
              onChange={(e) => setExitPrice(e.target.value)}
              placeholder="0.00"
              className="font-mono tabular-nums"
              data-testid="exit-price-input"
            />
          </div>

          {pnlPreview != null && (
            <div
              className={`text-sm font-mono tabular-nums ${
                pnlPreview > 0
                  ? 'text-bullish'
                  : pnlPreview < 0
                    ? 'text-bearish'
                    : 'text-muted-foreground'
              }`}
              data-testid="pnl-preview"
            >
              P&L: {pnlPreview > 0 ? '+' : ''}
              {pnlPreview.toFixed(2)}%
            </div>
          )}

          <Button
            size="sm"
            className="w-full"
            onClick={handleSubmit}
            disabled={!hasValidExit || updateMutation.isPending}
            data-testid="confirm-close-trade"
          >
            {updateMutation.isPending ? 'Closing...' : 'Close Trade'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
