'use client';

import React, { useState } from 'react';
import { toast } from 'sonner';
import { ChevronsUpDown } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { SegmentedControl } from '@/components/kit/SegmentedControl';
import { useCreateJournalEntry } from '@/hooks/useJournal';
import { useDiscipline } from '@/hooks/useDiscipline';
import { useSymbols } from '@/hooks/useSymbols';
import { useUIStore } from '@/stores/uiStore';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { MARKET_SESSIONS, SESSION_LABELS, type MarketSession } from '@/lib/sessions';
import { cn } from '@/lib/utils';
import {
  JOURNAL_ACTIONS,
  MARKET_CONDITIONS,
  TRADE_EMOTIONS,
  TRADE_EMOTION_LABELS,
  type CreateJournalEntryInput,
  type JournalAction,
  type MarketCondition,
  type TradeEmotion,
} from '@/types/journal';

export interface LogTradeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSymbol?: string;
}

function getBaseAsset(sym: string): string {
  return sym.replace(/(USDT|USDC|BUSD)$/, '') || sym;
}

interface LogTradeFormContentProps {
  initialSymbol?: string;
  onClose: () => void;
}

const LogTradeFormContent: React.FC<LogTradeFormContentProps> = ({
  initialSymbol,
  onClose,
}) => {
  const storeSymbol = useUIStore((s) => s.selectedSymbol);
  const defaultSymbol = initialSymbol || storeSymbol || 'BTCUSDT';

  const [selectedSymbol, setSelectedSymbol] = useState(defaultSymbol);
  const [openCoinPopover, setOpenCoinPopover] = useState(false);
  const [action, setAction] = useState<JournalAction>('buy');
  const [entryPrice, setEntryPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [plannedStop, setPlannedStop] = useState('');
  const [plannedTarget, setPlannedTarget] = useState('');
  const [setupType, setSetupType] = useState('');
  const [marketCondition, setMarketCondition] = useState<MarketCondition | ''>('');
  const [session, setSession] = useState<MarketSession | ''>('');
  const [emotion, setEmotion] = useState<TradeEmotion | ''>('');
  const [tagsInput, setTagsInput] = useState('');
  const [notes, setNotes] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const { data: symbolsData } = useSymbols();
  const { data: nudges } = useDiscipline(selectedSymbol, true);
  const createMutation = useCreateJournalEntry();

  const selectedBaseAsset =
    symbolsData?.find((s) => s.symbol === selectedSymbol)?.baseAsset ||
    getBaseAsset(selectedSymbol);

  const coinsList =
    symbolsData && symbolsData.length > 0
      ? symbolsData.map((s) => ({
          symbol: s.symbol,
          baseAsset: s.baseAsset || getBaseAsset(s.symbol),
        }))
      : SIGNAL_SYMBOLS.map((s) => ({
          symbol: s,
          baseAsset: getBaseAsset(s),
        }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: Record<string, string> = {};

    if (!selectedSymbol) {
      newErrors.symbol = 'Please select a coin.';
    }

    if (!action) {
      newErrors.action = 'Please select an action.';
    }

    const priceNum = entryPrice ? parseFloat(entryPrice) : undefined;
    if (entryPrice && (priceNum === undefined || isNaN(priceNum) || priceNum <= 0)) {
      newErrors.entryPrice = 'Entry price must be greater than 0.';
    }

    const qtyNum = quantity ? parseFloat(quantity) : undefined;
    if (quantity && (qtyNum === undefined || isNaN(qtyNum) || qtyNum <= 0)) {
      newErrors.quantity = 'Quantity must be greater than 0.';
    }

    const stopNum = plannedStop ? parseFloat(plannedStop) : undefined;
    if (plannedStop && (stopNum === undefined || isNaN(stopNum) || stopNum <= 0)) {
      newErrors.plannedStop = 'Planned stop must be greater than 0.';
    }

    const targetNum = plannedTarget ? parseFloat(plannedTarget) : undefined;
    if (plannedTarget && (targetNum === undefined || isNaN(targetNum) || targetNum <= 0)) {
      newErrors.plannedTarget = 'Planned target must be greater than 0.';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setErrors({});
    setServerError(null);

    // Compute planned risk/reward if both stop and target are specified and valid
    let plannedRiskReward: number | undefined = undefined;
    if (priceNum && stopNum && targetNum) {
      if (action === 'buy' && priceNum > stopNum && targetNum > priceNum) {
        const risk = priceNum - stopNum;
        const reward = targetNum - priceNum;
        plannedRiskReward = Number((reward / risk).toFixed(2));
      } else if (action === 'sell' && stopNum > priceNum && priceNum > targetNum) {
        const risk = stopNum - priceNum;
        const reward = priceNum - targetNum;
        plannedRiskReward = Number((reward / risk).toFixed(2));
      }
    }

    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const payload: CreateJournalEntryInput & Record<string, unknown> = {
      symbol: selectedSymbol,
      interval: '1h',
      signalScore: 0,
      signalTier: 'neutral',
      action,
      ...(priceNum !== undefined ? { entryPrice: priceNum } : {}),
      ...(qtyNum !== undefined ? { quantity: qtyNum } : {}),
      ...(stopNum !== undefined ? { plannedStop: stopNum } : {}),
      ...(targetNum !== undefined ? { plannedTarget: targetNum } : {}),
      ...(plannedRiskReward !== undefined ? { plannedRiskReward } : {}),
      ...(setupType.trim() ? { setupType: setupType.trim() } : {}),
      ...(marketCondition ? { marketCondition } : {}),
      ...(session ? { session } : {}),
      ...(emotion ? { emotion } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };

    try {
      await createMutation.mutateAsync(payload);
      toast.success('Trade saved');
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save trade';
      setServerError(msg);
    }
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>Log a trade</SheetTitle>
        <SheetDescription>Record a new trade entry in your journal.</SheetDescription>
      </SheetHeader>

      <form onSubmit={handleSubmit} className="space-y-5 py-4">
        {serverError && (
          <div
            role="alert"
            className="p-3 rounded-[8px] bg-destructive/10 text-destructive text-[14px] font-medium"
          >
            {serverError}
          </div>
        )}

        {/* Quiet discipline nudges */}
        {nudges && nudges.length > 0 && (
          <div
            data-testid="discipline-nudges"
            className="rounded-[12px] bg-muted/20 border border-edge/30 p-3 space-y-1.5"
          >
            <h4 className="text-[13px] font-semibold text-ink-2">Before you log</h4>
            <ul className="space-y-1 text-[13px] text-muted-foreground list-disc list-inside">
              {nudges.map((n, idx) => (
                <li key={idx}>{n.message}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Coin combobox */}
        <div className="flex flex-col gap-1.5">
          <label
            id="log-trade-symbol-label"
            htmlFor="log-trade-symbol-trigger"
            className="text-[14px] font-medium text-foreground"
          >
            Coin
          </label>
          <Popover open={openCoinPopover} onOpenChange={setOpenCoinPopover}>
            <PopoverTrigger asChild>
              <Button
                id="log-trade-symbol-trigger"
                type="button"
                variant="outline"
                role="combobox"
                aria-expanded={openCoinPopover}
                aria-labelledby="log-trade-symbol-label"
                className="flex min-h-[44px] w-full items-center justify-between px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-semibold text-[14px] focus-visible:outline-3 focus-visible:outline-ring cursor-pointer hover:bg-card"
              >
                <span className={cn(!selectedBaseAsset && 'text-muted-foreground font-normal')}>
                  {selectedBaseAsset || 'Select coin'}
                </span>
                <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[--radix-popover-trigger-width] min-w-56 p-0" align="start">
              <Command>
                <CommandInput placeholder="Search coin..." />
                <CommandList>
                  <CommandEmpty>No coin found.</CommandEmpty>
                  <CommandGroup>
                    {coinsList.map((c) => (
                      <CommandItem
                        key={c.symbol}
                        value={c.baseAsset}
                        onSelect={() => {
                          setSelectedSymbol(c.symbol);
                          setOpenCoinPopover(false);
                          if (errors.symbol) setErrors((prev) => ({ ...prev, symbol: '' }));
                        }}
                      >
                        {c.baseAsset}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {errors.symbol && (
            <p role="alert" className="text-[13px] text-down">
              {errors.symbol}
            </p>
          )}
        </div>

        {/* Action switcher */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[14px] font-medium text-foreground">Action</span>
          <SegmentedControl
            legend="Trade action"
            value={action}
            onChange={(val) => setAction(val as JournalAction)}
            options={JOURNAL_ACTIONS.map((act) => ({
              value: act,
              label: act.charAt(0).toUpperCase() + act.slice(1),
            }))}
          />
          {errors.action && (
            <p role="alert" className="text-[13px] text-down">
              {errors.action}
            </p>
          )}
        </div>

        {/* Entry Price & Quantity */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="log-trade-entry-price"
              className="text-[14px] font-medium text-foreground"
            >
              Entry price
            </label>
            <input
              id="log-trade-entry-price"
              type="number"
              step="any"
              placeholder="0.00"
              value={entryPrice}
              onChange={(e) => {
                setEntryPrice(e.target.value);
                if (errors.entryPrice) setErrors((prev) => ({ ...prev, entryPrice: '' }));
              }}
              className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-sans tabular-nums text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
            />
            {errors.entryPrice && (
              <p role="alert" className="text-[13px] text-down">
                {errors.entryPrice}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="log-trade-quantity"
              className="text-[14px] font-medium text-foreground"
            >
              Quantity
            </label>
            <input
              id="log-trade-quantity"
              type="number"
              step="any"
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
        </div>

        {/* Planned Stop & Planned Target */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="log-trade-stop"
              className="text-[14px] font-medium text-foreground"
            >
              Your planned stop
            </label>
            <input
              id="log-trade-stop"
              type="number"
              step="any"
              placeholder="0.00"
              value={plannedStop}
              onChange={(e) => {
                setPlannedStop(e.target.value);
                if (errors.plannedStop) setErrors((prev) => ({ ...prev, plannedStop: '' }));
              }}
              className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-sans tabular-nums text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
            />
            {errors.plannedStop && (
              <p role="alert" className="text-[13px] text-down">
                {errors.plannedStop}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="log-trade-target"
              className="text-[14px] font-medium text-foreground"
            >
              Your planned target
            </label>
            <input
              id="log-trade-target"
              type="number"
              step="any"
              placeholder="0.00"
              value={plannedTarget}
              onChange={(e) => {
                setPlannedTarget(e.target.value);
                if (errors.plannedTarget) setErrors((prev) => ({ ...prev, plannedTarget: '' }));
              }}
              className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-sans tabular-nums text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
            />
            {errors.plannedTarget && (
              <p role="alert" className="text-[13px] text-down">
                {errors.plannedTarget}
              </p>
            )}
          </div>
        </div>

        {/* Setup & Market condition */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="log-trade-setup" className="text-[14px] font-medium text-foreground">
              Setup
            </label>
            <input
              id="log-trade-setup"
              type="text"
              placeholder="e.g. 50 SMA bounce"
              value={setupType}
              onChange={(e) => setSetupType(e.target.value)}
              className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="log-trade-condition" className="text-[14px] font-medium text-foreground">
              Market condition
            </label>
            <select
              id="log-trade-condition"
              value={marketCondition}
              onChange={(e) => setMarketCondition(e.target.value as MarketCondition | '')}
              className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] cursor-pointer focus-visible:outline-3 focus-visible:outline-ring"
            >
              <option value="">Select condition</option>
              {MARKET_CONDITIONS.map((cond) => (
                <option key={cond} value={cond}>
                  {cond.replace('_', ' ')}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Session & Emotion before */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="log-trade-session" className="text-[14px] font-medium text-foreground">
              Session
            </label>
            <select
              id="log-trade-session"
              value={session}
              onChange={(e) => setSession(e.target.value as MarketSession | '')}
              className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] cursor-pointer focus-visible:outline-3 focus-visible:outline-ring"
            >
              <option value="">Select session</option>
              {MARKET_SESSIONS.map((sess) => (
                <option key={sess} value={sess}>
                  {SESSION_LABELS[sess]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="log-trade-emotion" className="text-[14px] font-medium text-foreground">
              Emotion before
            </label>
            <select
              id="log-trade-emotion"
              value={emotion}
              onChange={(e) => setEmotion(e.target.value as TradeEmotion | '')}
              className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] cursor-pointer focus-visible:outline-3 focus-visible:outline-ring"
            >
              <option value="">Select emotion</option>
              {TRADE_EMOTIONS.map((emo) => (
                <option key={emo} value={emo}>
                  {TRADE_EMOTION_LABELS[emo]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Tags */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="log-trade-tags" className="text-[14px] font-medium text-foreground">
            Tags
          </label>
          <input
            id="log-trade-tags"
            type="text"
            placeholder="breakout, trend (comma separated)"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
          />
        </div>

        {/* Notes */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="log-trade-notes" className="text-[14px] font-medium text-foreground">
            Notes
          </label>
          <textarea
            id="log-trade-notes"
            rows={3}
            placeholder="Trade plan, rationale, or context..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="min-h-[88px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] focus-visible:outline-3 focus-visible:outline-ring resize-y"
          />
        </div>

        <SheetFooter className="mt-6 flex flex-row justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            className="rounded-[12px] min-h-[44px] px-4 font-semibold"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={createMutation.isPending}
            className="rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold min-h-[44px] px-6"
          >
            {createMutation.isPending ? 'Saving...' : 'Save trade'}
          </Button>
        </SheetFooter>
      </form>
    </>
  );
};

export const LogTradeSheet: React.FC<LogTradeSheetProps> = ({
  open,
  onOpenChange,
  initialSymbol,
}) => {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        {open && (
          <LogTradeFormContent
            initialSymbol={initialSymbol}
            onClose={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
};
