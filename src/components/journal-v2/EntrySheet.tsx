'use client';

import React, { useState } from 'react';
import { toast } from 'sonner';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  useUpdateJournalEntry,
  useReviewJournalEntry,
  useDeleteJournalEntry,
} from '@/hooks/useJournal';
import { cn } from '@/lib/utils';
import {
  TRADE_EMOTIONS,
  TRADE_EMOTION_LABELS,
  TRADE_MISTAKES,
  TRADE_MISTAKE_LABELS,
  type JournalEntry,
  type TradeEmotion,
  type TradeMistake,
  type UpdateJournalEntryInput,
} from '@/types/journal';

export interface EntrySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: JournalEntry | null;
}

function formatCurrency(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) {
    return 'n/a';
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: val < 1 ? 4 : 2,
  }).format(val);
}

function formatPnl(pnl: number | null | undefined): { text: string; className: string } {
  if (pnl === null || pnl === undefined || !Number.isFinite(pnl)) {
    return { text: 'n/a', className: 'text-muted-foreground' };
  }
  if (pnl === 0) {
    return { text: '0.00%', className: 'text-foreground' };
  }
  const sign = pnl > 0 ? '+' : '';
  return {
    text: `${sign}${pnl.toFixed(2)}%`,
    className: pnl > 0 ? 'text-up' : 'text-down',
  };
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return 'n/a';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'n/a';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getBaseAsset(sym: string): string {
  return sym.replace(/(USDT|USDC|BUSD)$/, '') || sym;
}

interface EntryFormContentProps {
  entry: JournalEntry;
  onClose: () => void;
}

const EntryFormContent: React.FC<EntryFormContentProps> = ({ entry, onClose }) => {
  const updateMutation = useUpdateJournalEntry();
  const reviewMutation = useReviewJournalEntry();
  const deleteMutation = useDeleteJournalEntry();

  const [isEditing, setIsEditing] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  // Edit fields
  const [editPrice, setEditPrice] = useState(entry.entryPrice ? String(entry.entryPrice) : '');
  const [editNotes, setEditNotes] = useState(entry.notes || '');
  const [editTags, setEditTags] = useState(entry.tags ? entry.tags.join(', ') : '');
  const [editSetup, setEditSetup] = useState(entry.setupType || '');

  // Review fields
  const [reviewExitPrice, setReviewExitPrice] = useState(
    entry.exitPrice ? String(entry.exitPrice) : ''
  );
  const [reviewOutcome, setReviewOutcome] = useState(
    entry.outcomePnlPercent !== null && entry.outcomePnlPercent !== undefined
      ? String(entry.outcomePnlPercent)
      : ''
  );
  const [reviewEmotion, setReviewEmotion] = useState<TradeEmotion | ''>(entry.emotion || '');
  const [reviewMistakes, setReviewMistakes] = useState<TradeMistake[]>(entry.mistakes || []);
  const [reviewLesson, setReviewLesson] = useState(entry.lessonsLearned || '');

  const [serverError, setServerError] = useState<string | null>(null);

  const isClosed = entry.exitPrice !== null && entry.exitPrice !== undefined;
  const pnl = formatPnl(entry.outcomePnlPercent);

  const handleToggleMistake = (mistake: TradeMistake) => {
    setReviewMistakes((prev) =>
      prev.includes(mistake) ? prev.filter((m) => m !== mistake) : [...prev, mistake]
    );
  };

  const handleSaveMainFields = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    const priceNum = editPrice ? parseFloat(editPrice) : undefined;
    const tags = editTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const updatePayload: UpdateJournalEntryInput & { id: string } = {
      id: entry._id,
      notes: editNotes,
      setupType: editSetup,
      tags,
      ...(priceNum !== undefined ? { exitPrice: undefined, entryPrice: priceNum } : {}),
    };

    try {
      await updateMutation.mutateAsync(updatePayload);
      toast.success('Journal entry updated');
      setIsEditing(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update entry';
      setServerError(msg);
    }
  };

  const handleSaveReview = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    const exitPriceNum = reviewExitPrice ? parseFloat(reviewExitPrice) : undefined;
    const outcomeNum = reviewOutcome ? parseFloat(reviewOutcome) : undefined;

    const payload = {
      id: entry._id,
      lessonsLearned: reviewLesson.trim(),
      ...(exitPriceNum !== undefined ? { exitPrice: exitPriceNum } : {}),
      ...(outcomeNum !== undefined ? { outcomePnlPercent: outcomeNum } : {}),
      ...(reviewEmotion ? { emotion: reviewEmotion } : {}),
      ...(reviewMistakes.length > 0 ? { mistakes: reviewMistakes } : { mistakes: [] }),
    };

    try {
      await reviewMutation.mutateAsync(payload as unknown as { id: string; lessonsLearned: string });
      toast.success('Entry reviewed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to review entry';
      setServerError(msg);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(entry._id);
      setDeleteConfirmOpen(false);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to delete entry';
      setServerError(msg);
    }
  };

  return (
    <>
      <SheetHeader>
        <div className="flex items-center justify-between gap-2 mr-6">
          <SheetTitle>{getBaseAsset(entry.symbol)} Trade</SheetTitle>
          <span
            className={cn(
              'px-2.5 py-0.5 rounded-[6px] text-[12px] font-semibold uppercase tracking-wider',
              isClosed ? 'bg-muted/40 text-ink-2' : 'bg-brand/20 text-brand-line'
            )}
          >
            {isClosed ? 'Closed' : 'Open'}
          </span>
        </div>
        <SheetDescription>Logged on {formatDate(entry.createdAt)}</SheetDescription>
      </SheetHeader>

      <div className="space-y-6 py-4">
        {serverError && (
          <div
            role="alert"
            className="p-3 rounded-[8px] bg-destructive/10 text-destructive text-[14px] font-medium"
          >
            {serverError}
          </div>
        )}

        {/* Entry details / Edit section */}
        <div className="rounded-[14px] bg-card p-4 border border-edge/30 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[15px] font-semibold text-foreground">Trade details</h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsEditing(!isEditing)}
              className="rounded-[8px] min-h-[44px] px-3 text-[13px]"
            >
              {isEditing ? 'Cancel edit' : 'Edit trade'}
            </Button>
          </div>

          {isEditing ? (
            <form onSubmit={handleSaveMainFields} className="space-y-4 pt-2">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="edit-entry-price" className="text-[13px] font-medium text-foreground">
                  Entry price
                </label>
                <input
                  id="edit-entry-price"
                  type="number"
                  step="any"
                  value={editPrice}
                  onChange={(e) => setEditPrice(e.target.value)}
                  className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-sans tabular-nums text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="edit-setup" className="text-[13px] font-medium text-foreground">
                  Setup
                </label>
                <input
                  id="edit-setup"
                  type="text"
                  value={editSetup}
                  onChange={(e) => setEditSetup(e.target.value)}
                  className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="edit-tags" className="text-[13px] font-medium text-foreground">
                  Tags
                </label>
                <input
                  id="edit-tags"
                  type="text"
                  value={editTags}
                  onChange={(e) => setEditTags(e.target.value)}
                  className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="edit-notes" className="text-[13px] font-medium text-foreground">
                  Notes
                </label>
                <textarea
                  id="edit-notes"
                  rows={2}
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  className="min-h-[66px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] focus-visible:outline-3 focus-visible:outline-ring resize-y"
                />
              </div>

              <div className="flex justify-end pt-1">
                <Button
                  type="submit"
                  disabled={updateMutation.isPending}
                  className="rounded-[10px] min-h-[44px] px-4 font-semibold"
                >
                  {updateMutation.isPending ? 'Saving...' : 'Save changes'}
                </Button>
              </div>
            </form>
          ) : (
            <div className="grid grid-cols-2 gap-3 text-[14px] pt-1">
              <div>
                <span className="text-[13px] text-muted-foreground block">Action</span>
                <span className="font-semibold uppercase">{entry.action}</span>
              </div>
              <div>
                <span className="text-[13px] text-muted-foreground block">Entry price</span>
                <span className="font-sans tabular-nums font-medium">
                  {formatCurrency(entry.entryPrice)}
                </span>
              </div>
              {isClosed && (
                <>
                  <div>
                    <span className="text-[13px] text-muted-foreground block">Exit price</span>
                    <span className="font-sans tabular-nums font-medium">
                      {formatCurrency(entry.exitPrice)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[13px] text-muted-foreground block">Outcome P&L</span>
                    <span className={cn('font-sans tabular-nums font-medium', pnl.className)}>
                      {pnl.text}
                    </span>
                  </div>
                </>
              )}
              {entry.setupType && (
                <div className="col-span-2">
                  <span className="text-[13px] text-muted-foreground block">Setup</span>
                  <span className="text-foreground">{entry.setupType}</span>
                </div>
              )}
              {entry.notes && (
                <div className="col-span-2">
                  <span className="text-[13px] text-muted-foreground block">Notes</span>
                  <p className="text-foreground text-[14px] mt-0.5 whitespace-pre-wrap">
                    {entry.notes}
                  </p>
                </div>
              )}
              {entry.tags && entry.tags.length > 0 && (
                <div className="col-span-2">
                  <span className="text-[13px] text-muted-foreground block mb-1">Tags</span>
                  <div className="flex flex-wrap gap-1">
                    {entry.tags.map((t) => (
                      <span
                        key={t}
                        className="inline-block px-2 py-0.5 rounded-[6px] text-[12px] bg-muted/20 text-ink-2"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Review Form */}
        <div className="rounded-[14px] bg-card p-4 border border-edge/30 space-y-4">
          <h3 className="text-[15px] font-semibold text-foreground">Review trade</h3>
          <form onSubmit={handleSaveReview} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="review-exit-price"
                  className="text-[13px] font-medium text-foreground"
                >
                  Exit price
                </label>
                <input
                  id="review-exit-price"
                  type="number"
                  step="any"
                  placeholder="0.00"
                  value={reviewExitPrice}
                  onChange={(e) => setReviewExitPrice(e.target.value)}
                  className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-sans tabular-nums text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="review-outcome"
                  className="text-[13px] font-medium text-foreground"
                >
                  Outcome P&L (%)
                </label>
                <input
                  id="review-outcome"
                  type="number"
                  step="any"
                  placeholder="e.g. 5.5 or -2.3"
                  value={reviewOutcome}
                  onChange={(e) => setReviewOutcome(e.target.value)}
                  className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-sans tabular-nums text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="review-emotion" className="text-[13px] font-medium text-foreground">
                Emotion after
              </label>
              <select
                id="review-emotion"
                value={reviewEmotion}
                onChange={(e) => setReviewEmotion(e.target.value as TradeEmotion | '')}
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

            {/* Mistakes checkboxes */}
            <div className="space-y-2">
              <span className="text-[13px] font-medium text-foreground block">Mistakes</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {TRADE_MISTAKES.map((mistake) => {
                  const checked = reviewMistakes.includes(mistake);
                  return (
                    <label
                      key={mistake}
                      className={cn(
                        'min-h-[44px] px-3 py-2 rounded-[10px] border flex items-center gap-2.5 cursor-pointer text-[13px] transition-colors',
                        checked
                          ? 'border-foreground bg-muted/40 font-medium'
                          : 'border-edge/40 hover:bg-muted/20 text-muted-foreground'
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => handleToggleMistake(mistake)}
                        className="size-4 rounded accent-foreground cursor-pointer"
                      />
                      <span>{TRADE_MISTAKE_LABELS[mistake]}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Lesson learned */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="review-lesson" className="text-[13px] font-medium text-foreground">
                Lesson learned
              </label>
              <textarea
                id="review-lesson"
                rows={3}
                placeholder="Key takeaways, execution critique, or rules reinforced..."
                value={reviewLesson}
                onChange={(e) => setReviewLesson(e.target.value)}
                className="min-h-[88px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] focus-visible:outline-3 focus-visible:outline-ring resize-y"
              />
            </div>

            <div className="flex justify-end pt-1">
              <Button
                type="submit"
                disabled={reviewMutation.isPending}
                className="rounded-[10px] min-h-[44px] px-5 font-semibold"
              >
                {reviewMutation.isPending ? 'Saving review...' : 'Save review'}
              </Button>
            </div>
          </form>
        </div>

        {/* Destructive Delete Button */}
        <div className="pt-2 border-t border-line flex justify-end">
          <Button
            type="button"
            variant="destructive"
            onClick={() => setDeleteConfirmOpen(true)}
            className="rounded-[12px] min-h-[44px] px-4 font-semibold"
          >
            Delete trade
          </Button>
        </div>
      </div>

      <SheetFooter className="mt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          className="w-full rounded-[12px] min-h-[44px]"
        >
          Close
        </Button>
      </SheetFooter>

      {/* Confirmation Dialog for Delete */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete trade</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this trade entry? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-row justify-end gap-3 mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              className="rounded-[12px] min-h-[44px] px-4"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={handleDelete}
              className="rounded-[12px] min-h-[44px] px-4"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export const EntrySheet: React.FC<EntrySheetProps> = ({
  open,
  onOpenChange,
  entry,
}) => {
  if (!entry) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <EntryFormContent
          key={entry._id}
          entry={entry}
          onClose={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  );
};
