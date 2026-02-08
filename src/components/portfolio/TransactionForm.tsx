'use client';

import { useState } from 'react';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAddHolding, useRecordTransaction } from '@/hooks/usePortfolio';

const formSchema = z.object({
  symbol: z.string().min(1, 'Symbol is required'),
  baseAsset: z.string().min(1, 'Base asset is required'),
  quoteAsset: z.string().min(1, 'Quote asset is required'),
  type: z.enum(['buy', 'sell']),
  quantity: z.number().positive('Quantity must be positive'),
  price: z.number().nonnegative('Price must be non-negative'),
  date: z.string().optional(),
  notes: z.string().optional(),
  fee: z.number().nonnegative('Fee must be non-negative').optional(),
});

interface TransactionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'add-holding' | 'record-transaction';
  portfolioId: string;
  symbol?: string;
  baseAsset?: string;
  quoteAsset?: string;
  onSuccess?: () => void;
}

export function TransactionForm({
  open,
  onOpenChange,
  mode,
  portfolioId,
  symbol: fixedSymbol,
  baseAsset: fixedBaseAsset,
  quoteAsset: fixedQuoteAsset,
  onSuccess,
}: TransactionFormProps) {
  const addHolding = useAddHolding(portfolioId);
  const recordTransaction = useRecordTransaction(
    portfolioId,
    fixedSymbol ?? ''
  );

  const [symbol, setSymbol] = useState(fixedSymbol ?? '');
  const [baseAsset, setBaseAsset] = useState(fixedBaseAsset ?? '');
  const [quoteAsset, setQuoteAsset] = useState(fixedQuoteAsset ?? 'USDT');
  const [type, setType] = useState<'buy' | 'sell'>('buy');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [date, setDate] = useState('');
  const [notes, setNotes] = useState('');
  const [fee, setFee] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const isRecordMode = mode === 'record-transaction';
  const isPending = addHolding.isPending || recordTransaction.isPending;

  const resetForm = () => {
    if (!fixedSymbol) {
      setSymbol('');
      setBaseAsset('');
    }
    setType('buy');
    setQuantity('');
    setPrice('');
    setDate('');
    setNotes('');
    setFee('');
    setErrors({});
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const data = {
      symbol: isRecordMode ? fixedSymbol! : symbol.toUpperCase(),
      baseAsset: isRecordMode ? fixedBaseAsset! : baseAsset.toUpperCase(),
      quoteAsset: isRecordMode ? fixedQuoteAsset! : quoteAsset.toUpperCase(),
      type,
      quantity: parseFloat(quantity),
      price: parseFloat(price),
      date: date || undefined,
      notes: notes || undefined,
      fee: fee ? parseFloat(fee) : undefined,
    };

    const result = formSchema.safeParse(data);
    if (!result.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const field = issue.path[0]?.toString();
        if (field && !fieldErrors[field]) {
          fieldErrors[field] = issue.message;
        }
      }
      setErrors(fieldErrors);
      return;
    }

    setErrors({});

    const onDone = {
      onSuccess: () => {
        resetForm();
        onOpenChange(false);
        onSuccess?.();
      },
    };

    if (isRecordMode) {
      recordTransaction.mutate(
        { type: data.type, quantity: data.quantity, price: data.price, date: data.date, notes: data.notes, fee: data.fee },
        onDone
      );
    } else {
      addHolding.mutate(data, onDone);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isRecordMode ? `Record Transaction - ${fixedSymbol}` : 'Add Holding'}
          </DialogTitle>
          <DialogDescription>
            {isRecordMode
              ? 'Record a buy or sell transaction for this holding.'
              : 'Add a new holding to your portfolio by recording the first transaction.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {!isRecordMode && (
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label htmlFor="symbol">Symbol</Label>
                <Input
                  id="symbol"
                  placeholder="BTCUSDT"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                />
                {errors.symbol && (
                  <p className="text-xs text-destructive">{errors.symbol}</p>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="baseAsset">Base</Label>
                <Input
                  id="baseAsset"
                  placeholder="BTC"
                  value={baseAsset}
                  onChange={(e) => setBaseAsset(e.target.value)}
                />
                {errors.baseAsset && (
                  <p className="text-xs text-destructive">{errors.baseAsset}</p>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="quoteAsset">Quote</Label>
                <Input
                  id="quoteAsset"
                  placeholder="USDT"
                  value={quoteAsset}
                  onChange={(e) => setQuoteAsset(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              variant={type === 'buy' ? 'default' : 'outline'}
              size="sm"
              className={type === 'buy' ? 'bg-[#0ecb81] hover:bg-[#0ecb81]/90 text-white' : ''}
              onClick={() => setType('buy')}
            >
              Buy
            </Button>
            <Button
              type="button"
              variant={type === 'sell' ? 'default' : 'outline'}
              size="sm"
              className={type === 'sell' ? 'bg-[#f6465d] hover:bg-[#f6465d]/90 text-white' : ''}
              onClick={() => setType('sell')}
            >
              Sell
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="quantity">Quantity</Label>
              <Input
                id="quantity"
                type="number"
                step="any"
                min="0"
                placeholder="0.5"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
              {errors.quantity && (
                <p className="text-xs text-destructive">{errors.quantity}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="price">Price</Label>
              <Input
                id="price"
                type="number"
                step="any"
                min="0"
                placeholder="40000"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
              {errors.price && (
                <p className="text-xs text-destructive">{errors.price}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="date">Date</Label>
              <Input
                id="date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="fee">Fee</Label>
              <Input
                id="fee"
                type="number"
                step="any"
                min="0"
                placeholder="0"
                value={fee}
                onChange={(e) => setFee(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="notes">Notes</Label>
            <Input
              id="notes"
              placeholder="Optional notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Saving...' : isRecordMode ? 'Record' : 'Add'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
