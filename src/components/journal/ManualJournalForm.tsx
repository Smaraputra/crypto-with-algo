'use client';

import { useState } from 'react';
import { Plus, Eye, PenLine } from 'lucide-react';
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
import { TagInput } from './TagInput';
import { MarkdownPreview } from './MarkdownPreview';
import { JOURNAL_ACTIONS, MARKET_CONDITIONS } from '@/types/journal';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

const COMMON_INTERVALS = ['15m', '1h', '4h', '1d'] as const;

const MARKET_CONDITION_LABELS: Record<string, string> = {
  trending_up: 'Trending Up',
  trending_down: 'Trending Down',
  ranging: 'Ranging',
  volatile: 'Volatile',
  calm: 'Calm',
};

export function ManualJournalForm() {
  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [customSymbol, setCustomSymbol] = useState('');
  const [interval, setInterval] = useState('1h');
  const [action, setAction] = useState<(typeof JOURNAL_ACTIONS)[number]>('buy');
  const [entryPrice, setEntryPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [previewMode, setPreviewMode] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [setupType, setSetupType] = useState('');
  const [marketCondition, setMarketCondition] = useState<string>('');

  const createEntry = useCreateJournalEntry();

  const effectiveSymbol = symbol === 'custom' ? customSymbol.toUpperCase().trim() : symbol;

  function handleSubmit() {
    if (!effectiveSymbol) return;

    createEntry.mutate(
      {
        symbol: effectiveSymbol,
        interval,
        signalScore: 0,
        signalTier: 'neutral',
        action,
        entryPrice: entryPrice ? parseFloat(entryPrice) : undefined,
        notes: notes || undefined,
        tags: tags.length > 0 ? tags : undefined,
        setupType: setupType || undefined,
        marketCondition: marketCondition
          ? (marketCondition as (typeof MARKET_CONDITIONS)[number])
          : undefined,
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
    setSymbol('BTCUSDT');
    setCustomSymbol('');
    setInterval('1h');
    setAction('buy');
    setEntryPrice('');
    setNotes('');
    setPreviewMode(false);
    setTags([]);
    setSetupType('');
    setMarketCondition('');
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="new-entry-button">
          <Plus className="mr-1 size-4" />
          New Entry
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Journal Entry</DialogTitle>
          <DialogDescription>
            Record a trade or observation manually.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Symbol */}
          <div className="space-y-1">
            <Label className="text-xs">Symbol</Label>
            <Select value={symbol} onValueChange={setSymbol}>
              <SelectTrigger className="h-7 text-xs" data-testid="symbol-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIGNAL_SYMBOLS.map((s) => (
                  <SelectItem key={s} value={s} className="text-xs">
                    {s}
                  </SelectItem>
                ))}
                <SelectItem value="custom" className="text-xs">
                  Custom...
                </SelectItem>
              </SelectContent>
            </Select>
            {symbol === 'custom' && (
              <Input
                type="text"
                value={customSymbol}
                onChange={(e) => setCustomSymbol(e.target.value)}
                placeholder="e.g. MATICUSDT"
                className="h-7 text-xs font-mono mt-1"
                data-testid="custom-symbol-input"
              />
            )}
          </div>

          {/* Interval */}
          <div className="space-y-1">
            <Label className="text-xs">Interval</Label>
            <div className="flex gap-1">
              {COMMON_INTERVALS.map((iv) => (
                <Button
                  key={iv}
                  type="button"
                  size="sm"
                  variant={interval === iv ? 'default' : 'outline'}
                  className="h-7 text-xs"
                  onClick={() => setInterval(iv)}
                >
                  {iv}
                </Button>
              ))}
            </div>
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
              data-testid="entry-price-input"
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
                className="h-5 text-xs px-1.5"
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
                placeholder="Why did you enter this trade? Markdown supported."
                className="text-xs"
                rows={3}
                maxLength={10000}
                data-testid="journal-notes"
              />
            )}
          </div>

          {/* Submit */}
          <Button
            size="sm"
            className="w-full"
            onClick={handleSubmit}
            disabled={createEntry.isPending || !effectiveSymbol}
            data-testid="save-entry-button"
          >
            {createEntry.isPending ? 'Saving...' : 'Save Entry'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
