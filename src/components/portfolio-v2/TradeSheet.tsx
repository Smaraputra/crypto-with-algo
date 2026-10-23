'use client';

import React, { useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/kit/SegmentedControl';
import { useSymbols } from '@/hooks/useSymbols';
import { useAddHolding, useRecordTransaction } from '@/hooks/usePortfolio';
import type { Holding } from '@/types/portfolio';
import type { Symbol as MarketSymbol } from '@/types/market';

export interface TradeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  portfolioId: string;
  mode?: 'add' | 'record';
  initialHolding?: Holding | null;
}

function subscribeMediaQuery(callback: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia('(min-width: 640px)');
  mq.addEventListener('change', callback);
  return () => mq.removeEventListener('change', callback);
}

function getMediaQuerySnapshot(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(min-width: 640px)').matches;
}

function getMediaQueryServerSnapshot(): boolean {
  return true;
}

interface TradeFormProps {
  mode: 'add' | 'record';
  initialHolding: Holding | null;
  portfolioId: string;
  onClose: () => void;
  symbolsData?: MarketSymbol[];
}

const TradeForm: React.FC<TradeFormProps> = ({
  mode,
  initialHolding,
  portfolioId,
  onClose,
  symbolsData,
}) => {
  const addHoldingMutation = useAddHolding(portfolioId);
  const recordTxMutation = useRecordTransaction(
    portfolioId,
    initialHolding?.symbol || ''
  );

  const [selectedSymbol, setSelectedSymbol] = useState(initialHolding?.symbol || '');
  const [txType, setTxType] = useState<'buy' | 'sell'>('buy');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState(
    initialHolding?.avgBuyPrice ? String(initialHolding.avgBuyPrice) : ''
  );
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [fee, setFee] = useState('');
  const [note, setNote] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: Record<string, string> = {};

    if (mode === 'add' && !selectedSymbol) {
      newErrors.symbol = 'Please select a coin.';
    }

    const qtyNum = parseFloat(quantity);
    if (!quantity || isNaN(qtyNum) || qtyNum <= 0) {
      newErrors.quantity = 'Quantity must be greater than 0.';
    } else if (
      mode === 'record' &&
      txType === 'sell' &&
      initialHolding &&
      qtyNum > initialHolding.quantity
    ) {
      newErrors.quantity = 'Sell quantity cannot exceed held quantity.';
    }

    const priceNum = parseFloat(price);
    if (!price || isNaN(priceNum) || priceNum <= 0) {
      newErrors.price = 'Price must be greater than 0.';
    }

    if (date) {
      const chosen = new Date(date);
      const now = new Date();
      const endOfToday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        23,
        59,
        59,
        999
      );
      if (chosen > endOfToday) {
        newErrors.date = 'Date cannot be in the future.';
      }
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setErrors({});
    setServerError(null);

    try {
      if (mode === 'add') {
        const symbolObj = symbolsData?.find((s) => s.symbol === selectedSymbol);
        const baseAsset =
          symbolObj?.baseAsset || selectedSymbol.replace(/(USDT|USDC|BUSD)$/, '');
        const quoteAsset = symbolObj?.quoteAsset || 'USDT';

        await addHoldingMutation.mutateAsync({
          symbol: selectedSymbol,
          baseAsset,
          quoteAsset,
          type: 'buy',
          quantity: qtyNum,
          price: priceNum,
          date: date ? new Date(date).toISOString() : undefined,
          fee: fee ? parseFloat(fee) : undefined,
          notes: note || undefined,
        });
      } else {
        await recordTxMutation.mutateAsync({
          type: txType,
          quantity: qtyNum,
          price: priceNum,
          date: date ? new Date(date).toISOString() : undefined,
          fee: fee ? parseFloat(fee) : undefined,
          notes: note || undefined,
        });
      }
      toast.success('Trade saved');
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save trade';
      setServerError(message);
    }
  };

  const isSubmitting = addHoldingMutation.isPending || recordTxMutation.isPending;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 py-4">
      {serverError && (
        <div
          role="alert"
          className="p-3 rounded-[8px] bg-destructive/10 text-destructive text-[14px] font-medium"
        >
          {serverError}
        </div>
      )}

      {mode === 'add' ? (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="trade-symbol"
            className="text-[14px] font-medium text-foreground"
          >
            Coin
          </label>
          <select
            id="trade-symbol"
            value={selectedSymbol}
            onChange={(e) => {
              setSelectedSymbol(e.target.value);
              if (errors.symbol) setErrors((prev) => ({ ...prev, symbol: '' }));
            }}
            className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-semibold text-[14px] focus-visible:outline-3 focus-visible:outline-ring cursor-pointer"
          >
            <option value="">Select coin</option>
            {symbolsData?.map((s) => (
              <option key={s.symbol} value={s.symbol}>
                {s.baseAsset} ({s.quoteAsset})
              </option>
            ))}
          </select>
          {errors.symbol && (
            <p role="alert" className="text-[13px] text-down">
              {errors.symbol}
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-[14px] font-medium text-foreground">Type</span>
          <SegmentedControl
            legend="Transaction type"
            value={txType}
            onChange={(val) => setTxType(val as 'buy' | 'sell')}
            options={[
              { value: 'buy', label: 'Buy' },
              { value: 'sell', label: 'Sell' },
            ]}
          />
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="trade-quantity"
          className="text-[14px] font-medium text-foreground"
        >
          Quantity
        </label>
        <input
          id="trade-quantity"
          type="number"
          step="any"
          min="0"
          placeholder="0.00"
          value={quantity}
          onChange={(e) => {
            setQuantity(e.target.value);
            if (errors.quantity) setErrors((prev) => ({ ...prev, quantity: '' }));
          }}
          className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-sans tabular-nums text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
        />
        {errors.quantity && (
          <p role="alert" className="text-[13px] text-down">
            {errors.quantity}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="trade-price"
          className="text-[14px] font-medium text-foreground"
        >
          {mode === 'add' ? 'Buy price' : 'Price'}
        </label>
        <input
          id="trade-price"
          type="number"
          step="any"
          min="0"
          placeholder="0.00"
          value={price}
          onChange={(e) => {
            setPrice(e.target.value);
            if (errors.price) setErrors((prev) => ({ ...prev, price: '' }));
          }}
          className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-sans tabular-nums text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
        />
        {errors.price && (
          <p role="alert" className="text-[13px] text-down">
            {errors.price}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="trade-date"
          className="text-[14px] font-medium text-foreground"
        >
          Date
        </label>
        <input
          id="trade-date"
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            if (errors.date) setErrors((prev) => ({ ...prev, date: '' }));
          }}
          className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-sans text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
        />
        {errors.date && (
          <p role="alert" className="text-[13px] text-down">
            {errors.date}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="trade-fee"
          className="text-[14px] font-medium text-foreground"
        >
          Fee
        </label>
        <input
          id="trade-fee"
          type="number"
          step="any"
          min="0"
          placeholder="0.00"
          value={fee}
          onChange={(e) => setFee(e.target.value)}
          className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-sans tabular-nums text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="trade-note"
          className="text-[14px] font-medium text-foreground"
        >
          Note
        </label>
        <input
          id="trade-note"
          type="text"
          placeholder="Optional notes"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
        />
      </div>

      <SheetFooter className="mt-4 flex flex-row justify-end gap-3 p-0">
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          className="rounded-[12px] min-h-[44px] px-4"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={isSubmitting}
          className="rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold min-h-[44px] px-5"
        >
          {isSubmitting ? 'Saving...' : 'Save trade'}
        </Button>
      </SheetFooter>
    </form>
  );
};

export const TradeSheet: React.FC<TradeSheetProps> = ({
  open,
  onOpenChange,
  portfolioId,
  mode = 'add',
  initialHolding = null,
}) => {
  const { data: symbolsData } = useSymbols();
  const isDesktop = useSyncExternalStore(
    subscribeMediaQuery,
    getMediaQuerySnapshot,
    getMediaQueryServerSnapshot
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isDesktop ? 'right' : 'bottom'}
        className="w-full sm:max-w-md overflow-y-auto max-sm:max-h-[90vh]"
      >
        <SheetHeader className="text-left space-y-1">
          <SheetTitle className="text-[20px] font-semibold text-foreground">
            {mode === 'add' ? 'Add a holding' : 'Record a trade'}
          </SheetTitle>
          <SheetDescription className="text-[14px] text-muted-foreground">
            {mode === 'add'
              ? 'Select a coin and record your opening purchase.'
              : `Record a buy or sell trade for ${initialHolding?.baseAsset || 'holding'}.`}
          </SheetDescription>
        </SheetHeader>

        {open && (
          <TradeForm
            key={initialHolding?.symbol ? `record-${initialHolding.symbol}` : 'add-new'}
            mode={mode}
            initialHolding={initialHolding}
            portfolioId={portfolioId}
            onClose={() => onOpenChange(false)}
            symbolsData={symbolsData}
          />
        )}
      </SheetContent>
    </Sheet>
  );
};
