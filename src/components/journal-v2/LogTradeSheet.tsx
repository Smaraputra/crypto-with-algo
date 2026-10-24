'use client';

import React, { useEffect, useRef, useState } from 'react';
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
import {
  useCreateJournalEntry,
  useUploadJournalScreenshot,
} from '@/hooks/useJournal';
import { useDiscipline } from '@/hooks/useDiscipline';
import { useLatestSignalForStyle } from '@/hooks/useSignals';
import { useUIStore } from '@/stores/uiStore';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { scoredIntervals } from '@/lib/indicators/style-configs';
import { tierDisplayLabel } from '@/lib/signals/tier-labels';
import {
  toLocalInputValue,
  fromLocalInputValue,
} from '@/lib/journal/format';
import type { TradingStyle } from '@/lib/models/signal-template';
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
import { ScreenshotDropZone } from './ScreenshotDropZone';

export interface LogTradeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSymbol?: string;
}

function getBaseAsset(sym: string): string {
  return sym.replace(/(USDT|USDC|BUSD)$/, '') || sym;
}

const CANDIDATE_STYLES: TradingStyle[] = ['scalping', 'day_trading', 'swing_trading'];

export interface ScoredPair {
  style: TradingStyle;
  interval: string;
}

function getScoredPairs(): ScoredPair[] {
  const pairs: ScoredPair[] = [];
  const seenIntervals = new Set<string>();

  for (const style of CANDIDATE_STYLES) {
    const intervals = scoredIntervals(style);
    for (const interval of intervals) {
      if (!seenIntervals.has(interval)) {
        seenIntervals.add(interval);
        pairs.push({ style, interval });
      }
    }
  }
  return pairs;
}

export const SCORED_PAIRS = getScoredPairs();

const SIGNAL_COINS = SIGNAL_SYMBOLS.map((s) => ({
  symbol: s,
  baseAsset: getBaseAsset(s),
}));

const CONVICTION_OPTIONS = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
  { value: '5', label: '5' },
];

interface LogTradeFormContentProps {
  initialSymbol?: string;
  onClose: () => void;
}

interface PendingScreenshot {
  file: File;
  url: string;
  id: string;
}

const LogTradeFormContent: React.FC<LogTradeFormContentProps> = ({
  initialSymbol,
  onClose,
}) => {
  const storeSymbol = useUIStore((s) => s.selectedSymbol);
  const isSignalSymbol = (s?: string | null): s is (typeof SIGNAL_SYMBOLS)[number] =>
    !!s && (SIGNAL_SYMBOLS as readonly string[]).includes(s);

  const defaultSymbol =
    (initialSymbol && isSignalSymbol(initialSymbol) && initialSymbol) ||
    (isSignalSymbol(storeSymbol) ? storeSymbol : 'BTCUSDT');

  const [selectedSymbol, setSelectedSymbol] = useState(defaultSymbol);
  const [selectedInterval, setSelectedInterval] = useState('1h');
  const [openCoinPopover, setOpenCoinPopover] = useState(false);
  const [action, setAction] = useState<JournalAction>('buy');
  const [entryPrice, setEntryPrice] = useState('');
  const [enteredAt, setEnteredAt] = useState(() => toLocalInputValue(new Date()));
  const [plannedRiskReward, setPlannedRiskReward] = useState('');
  const [conviction, setConviction] = useState('');
  const [setupType, setSetupType] = useState('');
  const [marketCondition, setMarketCondition] = useState<MarketCondition | ''>('');
  const [emotion, setEmotion] = useState<TradeEmotion | ''>('');
  const [tagsInput, setTagsInput] = useState('');
  const [notes, setNotes] = useState('');

  const [pendingFiles, setPendingFiles] = useState<PendingScreenshot[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const pendingFilesRef = useRef(pendingFiles);

  useEffect(() => {
    pendingFilesRef.current = pendingFiles;
  }, [pendingFiles]);

  useEffect(() => {
    return () => {
      pendingFilesRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, []);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const { data: nudges } = useDiscipline(selectedSymbol, true);
  const createMutation = useCreateJournalEntry();
  const uploadMutation = useUploadJournalScreenshot();

  const currentPair =
    SCORED_PAIRS.find((p) => p.interval === selectedInterval) ??
    SCORED_PAIRS.find((p) => p.interval === '1h')!;
  const currentStyle = currentPair.style;

  const {
    data: signalData,
    isLoading: isSignalLoading,
    isError: isSignalError,
  } = useLatestSignalForStyle(selectedSymbol, currentStyle, selectedInterval);
  const signal = signalData?.signal;

  const isSaveDisabled =
    createMutation.isPending || isUploading || isSignalLoading || isSignalError || !signal;

  const selectedBaseAsset = getBaseAsset(selectedSymbol);

  const handleAddPendingFiles = (newFiles: File[]) => {
    const remainingSlots = 4 - pendingFiles.length;
    const toAdd = newFiles.slice(0, remainingSlots).map((file) => ({
      file,
      url: URL.createObjectURL(file),
      id: `${file.name}-${file.lastModified}-${Math.random()}`,
    }));
    setPendingFiles((prev) => [...prev, ...toAdd]);
  };

  const handleRemovePendingFile = (id: string) => {
    setPendingFiles((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) {
        URL.revokeObjectURL(target.url);
      }
      return prev.filter((item) => item.id !== id);
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaveDisabled || !signal) {
      return;
    }

    const newErrors: Record<string, string> = {};

    if (!selectedSymbol) {
      newErrors.symbol = 'Please select a coin.';
    }

    if (!action) {
      newErrors.action = 'Please select an action.';
    }

    if (!enteredAt || !enteredAt.trim()) {
      newErrors.enteredAt = 'Enter when the trade was entered.';
    } else {
      const enteredDate = new Date(enteredAt);
      if (isNaN(enteredDate.getTime())) {
        newErrors.enteredAt = 'Enter when the trade was entered.';
      } else if (enteredDate.getTime() > Date.now() + 5 * 60 * 1000) {
        newErrors.enteredAt = 'Entered at cannot be in the future.';
      }
    }

    const priceNum = entryPrice ? parseFloat(entryPrice) : undefined;
    if (entryPrice && (priceNum === undefined || isNaN(priceNum) || priceNum <= 0)) {
      newErrors.entryPrice = 'Entry price must be greater than 0.';
    }

    const riskRewardNum = plannedRiskReward ? parseFloat(plannedRiskReward) : undefined;
    if (
      plannedRiskReward &&
      (riskRewardNum === undefined || isNaN(riskRewardNum) || riskRewardNum <= 0 || riskRewardNum > 100)
    ) {
      newErrors.plannedRiskReward =
        'Planned risk to reward must be greater than 0 and at most 100.';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setErrors({});
    setServerError(null);

    const convictionNum = conviction ? parseInt(conviction, 10) : undefined;

    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const enteredAtIso = fromLocalInputValue(enteredAt);
    if (!enteredAtIso) {
      setErrors({ enteredAt: 'Enter when the trade was entered.' });
      return;
    }

    const payload: CreateJournalEntryInput = {
      symbol: selectedSymbol,
      interval: selectedInterval,
      signalScore: signal.score,
      signalTier: signal.tier,
      action,
      enteredAt: enteredAtIso as unknown as Date,
      ...(priceNum !== undefined ? { entryPrice: priceNum } : {}),
      ...(riskRewardNum !== undefined ? { plannedRiskReward: riskRewardNum } : {}),
      ...(convictionNum !== undefined ? { convictionLevel: convictionNum } : {}),
      ...(setupType.trim() ? { setupType: setupType.trim() } : {}),
      ...(marketCondition ? { marketCondition } : {}),
      ...(emotion ? { emotion } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };

    try {
      setIsUploading(true);
      const res = (await createMutation.mutateAsync(payload)) as unknown as
        | { entry?: { _id: string }; _id?: string }
        | undefined;
      const newEntryId = res?.entry?._id ?? res?._id;

      let failedCount = 0;
      if (newEntryId && pendingFiles.length > 0) {
        for (const item of pendingFiles) {
          try {
            await uploadMutation.mutateAsync({ entryId: newEntryId, file: item.file });
          } catch {
            failedCount++;
          }
        }
      }

      if (failedCount > 0) {
        toast.error(
          `Trade saved. ${failedCount} screenshots did not upload. Add them from the trade.`
        );
      } else {
        toast.success('Trade saved');
      }

      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save trade';
      setServerError(msg);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>Log a trade</SheetTitle>
        <SheetDescription>Record a new trade entry in your journal.</SheetDescription>
      </SheetHeader>

      <form noValidate onSubmit={handleSubmit} className="space-y-5 px-4 pb-6 pt-2 sm:px-6">
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
              {nudges.map((n) => (
                <li key={n.rule}>{n.message}</li>
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
                    {SIGNAL_COINS.map((c) => (
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
          <p className="text-[13px] text-muted-foreground">
            Trades are linked to the price score at the time you log them, which covers these ten coins.
          </p>
          {errors.symbol && (
            <p role="alert" className="text-[13px] text-down">
              {errors.symbol}
            </p>
          )}
        </div>

        {/* Score interval */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[14px] font-medium text-foreground">Score interval</span>
          <SegmentedControl
            legend="Score interval"
            value={selectedInterval}
            onChange={setSelectedInterval}
            options={SCORED_PAIRS.map((p) => ({
              value: p.interval,
              label: p.interval,
            }))}
          />
          {isSignalLoading && (
            <p className="text-[13px] text-muted-foreground">Loading the price score.</p>
          )}
          {!isSignalLoading && (isSignalError || !signal) && (
            <p role="alert" className="text-[13px] text-down">
              No price score is available for this coin and interval yet, so the trade cannot be linked to one. Choose another interval or try again shortly.
            </p>
          )}
          {!isSignalLoading && !isSignalError && signal && (
            <p className="text-[13px] text-muted-foreground">
              Price score now: {tierDisplayLabel(signal.tier)}, {signal.score.toFixed(1)}.
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

        {/* Entry Price & Entered at beside each other */}
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
              htmlFor="log-trade-entered-at"
              className="text-[14px] font-medium text-foreground"
            >
              Entered at
            </label>
            <input
              id="log-trade-entered-at"
              type="datetime-local"
              required
              max={toLocalInputValue(new Date())}
              value={enteredAt}
              onChange={(e) => {
                setEnteredAt(e.target.value);
                if (errors.enteredAt) setErrors((prev) => ({ ...prev, enteredAt: '' }));
              }}
              className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-sans tabular-nums text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
            />
            {errors.enteredAt && (
              <p role="alert" className="text-[13px] text-down">
                {errors.enteredAt}
              </p>
            )}
          </div>
        </div>

        {/* Planned risk to reward moved to next row */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="log-trade-risk-reward"
            className="text-[14px] font-medium text-foreground"
          >
            Planned risk to reward
          </label>
          <input
            id="log-trade-risk-reward"
            type="number"
            step="any"
            placeholder="e.g. 2.0"
            value={plannedRiskReward}
            onChange={(e) => {
              setPlannedRiskReward(e.target.value);
              if (errors.plannedRiskReward) {
                setErrors((prev) => ({ ...prev, plannedRiskReward: '' }));
              }
            }}
            className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-sans tabular-nums text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
          />
          {errors.plannedRiskReward && (
            <p role="alert" className="text-[13px] text-down">
              {errors.plannedRiskReward}
            </p>
          )}
        </div>

        {/* Conviction */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[14px] font-medium text-foreground">Conviction</span>
          <SegmentedControl
            legend="Conviction"
            value={conviction}
            onChange={setConviction}
            options={CONVICTION_OPTIONS}
          />
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

        {/* Emotion before */}
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

        {/* Screenshots block */}
        <div className="space-y-3">
          <span className="text-[14px] font-medium text-foreground">Screenshots</span>
          {pendingFiles.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {pendingFiles.map((item) => (
                <div key={item.id} className="flex flex-col gap-1.5">
                  <div className="aspect-[4/3] w-full overflow-hidden rounded-[8px] border border-edge bg-muted/20">
                    {/* eslint-disable-next-line @next/next/no-img-element -- private screenshots (auth-only API or a local blob) must not pass through the public image optimizer */}
                    <img
                      src={item.url}
                      alt={item.file.name}
                      className="size-full aspect-[4/3] object-cover rounded-[8px]"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Remove ${item.file.name}`}
                    onClick={() => handleRemovePendingFile(item.id)}
                    className="w-full min-h-[44px] text-[12px] rounded-[8px]"
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
          <ScreenshotDropZone
            remaining={4 - pendingFiles.length}
            disabled={isSaveDisabled}
            onFiles={handleAddPendingFiles}
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
            disabled={isSaveDisabled}
            className="rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold min-h-[44px] px-6"
          >
            {createMutation.isPending || isUploading ? 'Saving...' : 'Save trade'}
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
