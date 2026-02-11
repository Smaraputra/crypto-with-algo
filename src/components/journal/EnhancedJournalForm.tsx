'use client';

import { useState } from 'react';
import { BookOpen, Eye, PenLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreateJournalEntry } from '@/hooks/useJournal';
import { useIndicatorSnapshot } from '@/hooks/useIndicatorSnapshot';
import { TagInput } from './TagInput';
import { MarkdownPreview } from './MarkdownPreview';
import { JOURNAL_ACTIONS, MARKET_CONDITIONS } from '@/types/journal';
import type { SignalTier } from '@/types/signal';
import type { IndicatorSnapshot } from '@/types/indicator-snapshot';

interface EnhancedJournalFormProps {
  symbol: string;
  interval: string;
  score: number;
  tier: SignalTier;
  confidence?: number;
  sentiment?: { fearGreedIndex: number; fearGreedLabel: string } | null;
}

const MARKET_CONDITION_LABELS: Record<string, string> = {
  trending_up: 'Trending Up',
  trending_down: 'Trending Down',
  ranging: 'Ranging',
  volatile: 'Volatile',
  calm: 'Calm',
};

export function EnhancedJournalForm({
  symbol,
  interval,
  score,
  tier,
  confidence,
  sentiment,
}: EnhancedJournalFormProps) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<(typeof JOURNAL_ACTIONS)[number]>('hold');
  const [entryPrice, setEntryPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [previewMode, setPreviewMode] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [setupType, setSetupType] = useState('');
  const [marketCondition, setMarketCondition] = useState<string>('');
  const [capturedSnapshot, setCapturedSnapshot] = useState<IndicatorSnapshot | null>(null);

  const createEntry = useCreateJournalEntry();
  const { data: liveSnapshot } = useIndicatorSnapshot(open ? symbol : null, interval);

  function handleCaptureSnapshot() {
    if (liveSnapshot) {
      setCapturedSnapshot(liveSnapshot);
    }
  }

  function handleSubmit() {
    createEntry.mutate(
      {
        symbol,
        interval,
        signalScore: score,
        signalTier: tier,
        action,
        entryPrice: entryPrice ? parseFloat(entryPrice) : undefined,
        notes: notes || undefined,
        tags: tags.length > 0 ? tags : undefined,
        setupType: setupType || undefined,
        marketCondition: marketCondition
          ? (marketCondition as (typeof MARKET_CONDITIONS)[number])
          : undefined,
        indicatorSnapshot: capturedSnapshot
          ? (capturedSnapshot as unknown as Record<string, unknown>)
          : undefined,
        sentiment: sentiment || undefined,
      },
      {
        onSuccess: () => {
          setOpen(false);
          resetForm();
        },
      }
    );
  }

  function resetForm() {
    setAction('hold');
    setEntryPrice('');
    setNotes('');
    setPreviewMode(false);
    setTags([]);
    setSetupType('');
    setMarketCondition('');
    setCapturedSnapshot(null);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="text-xs"
          data-testid="enhanced-journal-button"
        >
          <BookOpen className="mr-1 size-3.5" />
          Log to Journal
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Log Signal to Journal</DialogTitle>
          <DialogDescription>
            Record your trading decision for {symbol} {interval}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Signal Context */}
          <div className="flex items-center gap-2 text-xs bg-muted/50 rounded px-2 py-1.5">
            <span className="font-medium">{symbol}</span>
            <span className="text-muted-foreground">{interval}</span>
            <span className="font-mono tabular-nums">Score: {Math.round(score)}</span>
            <span className="capitalize text-muted-foreground">
              {tier.replace('_', ' ')}
            </span>
            {confidence != null && (
              <span className="text-muted-foreground">
                ({Math.round(confidence)}% conf)
              </span>
            )}
            {sentiment && (
              <span className="text-muted-foreground">
                F&G: {sentiment.fearGreedIndex}
              </span>
            )}
          </div>

          {/* Action */}
          <div className="space-y-1">
            <Label className="text-xs">Action</Label>
            <div className="flex gap-1">
              {JOURNAL_ACTIONS.map((a) => (
                <Button
                  key={a}
                  type="button"
                  size="sm"
                  variant={action === a ? 'default' : 'outline'}
                  className="h-7 text-xs capitalize"
                  onClick={() => setAction(a)}
                >
                  {a}
                </Button>
              ))}
            </div>
          </div>

          {/* Entry Price */}
          <div className="space-y-1">
            <Label className="text-xs">Entry Price (optional)</Label>
            <Input
              type="number"
              value={entryPrice}
              onChange={(e) => setEntryPrice(e.target.value)}
              placeholder="42000"
              className="h-7 text-xs font-mono"
              step="any"
              min="0"
            />
          </div>

          {/* Setup Type & Market Condition */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Setup Type</Label>
              <Input
                type="text"
                value={setupType}
                onChange={(e) => setSetupType(e.target.value)}
                placeholder="e.g. breakout, reversal"
                className="h-7 text-xs"
                maxLength={100}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Market Condition</Label>
              <Select value={marketCondition} onValueChange={setMarketCondition}>
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue placeholder="Select..." />
                </SelectTrigger>
                <SelectContent>
                  {MARKET_CONDITIONS.map((mc) => (
                    <SelectItem key={mc} value={mc} className="text-xs">
                      {MARKET_CONDITION_LABELS[mc]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Tags */}
          <div className="space-y-1">
            <Label className="text-xs">Tags</Label>
            <TagInput value={tags} onChange={setTags} />
          </div>

          {/* Notes */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Notes (markdown supported)</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-5 text-[10px] px-1.5"
                onClick={() => setPreviewMode(!previewMode)}
              >
                {previewMode ? (
                  <>
                    <PenLine className="mr-0.5 size-3" />
                    Edit
                  </>
                ) : (
                  <>
                    <Eye className="mr-0.5 size-3" />
                    Preview
                  </>
                )}
              </Button>
            </div>
            {previewMode ? (
              <div className="min-h-[72px] border rounded-md p-2 bg-muted/30">
                <MarkdownPreview content={notes} />
              </div>
            ) : (
              <Textarea
                value={notes}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  setNotes(e.target.value)
                }
                placeholder="Why did you choose this action? Markdown supported."
                className="text-xs"
                rows={3}
                maxLength={10000}
                data-testid="journal-notes"
              />
            )}
          </div>

          {/* Indicator Snapshot */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Indicator Snapshot</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-5 text-[10px] px-1.5"
                onClick={handleCaptureSnapshot}
                disabled={!liveSnapshot}
                data-testid="capture-snapshot-button"
              >
                {capturedSnapshot ? 'Recapture' : 'Capture'}
              </Button>
            </div>
            {capturedSnapshot && (
              <p className="text-[10px] text-muted-foreground">
                Snapshot captured (RSI: {capturedSnapshot.rsi ?? '-'}, ATR:{' '}
                {capturedSnapshot.atr ?? '-'})
              </p>
            )}
          </div>

          {/* Submit */}
          <Button
            size="sm"
            className="w-full"
            onClick={handleSubmit}
            disabled={createEntry.isPending}
          >
            {createEntry.isPending ? 'Saving...' : 'Save Entry'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
