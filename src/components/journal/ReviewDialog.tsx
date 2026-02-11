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
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useReviewJournalEntry } from '@/hooks/useJournal';
import type { JournalEntry } from '@/types/journal';

interface ReviewDialogProps {
  entry: JournalEntry;
  trigger?: React.ReactNode;
}

export function ReviewDialog({ entry, trigger }: ReviewDialogProps) {
  const [open, setOpen] = useState(false);
  const [lessonsLearned, setLessonsLearned] = useState(entry.lessonsLearned || '');
  const reviewMutation = useReviewJournalEntry();

  const pnl = entry.outcomePnlPercent;
  const isWin = pnl != null && pnl > 0;

  function handleSubmit() {
    reviewMutation.mutate(
      { id: entry._id, lessonsLearned },
      { onSuccess: () => setOpen(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button size="sm" variant="outline" className="text-xs">
            Review
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Review Trade</DialogTitle>
          <DialogDescription>
            Review your {entry.symbol} {entry.action} trade and record lessons learned.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">Symbol:</span>{' '}
              <span className="font-medium">{entry.symbol}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Action:</span>{' '}
              <span className="capitalize font-medium">{entry.action}</span>
            </div>
            {entry.entryPrice != null && (
              <div>
                <span className="text-muted-foreground">Entry:</span>{' '}
                <span className="font-mono tabular-nums">${entry.entryPrice.toLocaleString()}</span>
              </div>
            )}
            {entry.exitPrice != null && (
              <div>
                <span className="text-muted-foreground">Exit:</span>{' '}
                <span className="font-mono tabular-nums">${entry.exitPrice.toLocaleString()}</span>
              </div>
            )}
            {pnl != null && (
              <div className="col-span-2">
                <span className="text-muted-foreground">P&L:</span>{' '}
                <span
                  className={`font-mono tabular-nums ${
                    isWin ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-muted-foreground'
                  }`}
                >
                  {pnl > 0 ? '+' : ''}
                  {pnl.toFixed(2)}%
                </span>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Lessons Learned</Label>
            <Textarea
              value={lessonsLearned}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                setLessonsLearned(e.target.value)
              }
              placeholder="What did you learn from this trade? What would you do differently?"
              className="text-xs"
              rows={4}
              maxLength={10000}
              data-testid="lessons-learned-input"
            />
          </div>

          <Button
            size="sm"
            className="w-full"
            onClick={handleSubmit}
            disabled={reviewMutation.isPending}
          >
            {reviewMutation.isPending ? 'Saving...' : 'Mark as Reviewed'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
