/** @deprecated Use EnhancedJournalForm from @/components/journal/EnhancedJournalForm instead. */
'use client';

import { useState } from 'react';
import { BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCreateJournalEntry } from '@/hooks/useJournal';
import { JOURNAL_ACTIONS } from '@/types/journal';
import type { SignalTier } from '@/types/signal';

interface JournalFormProps {
  symbol: string;
  interval: string;
  score: number;
  tier: SignalTier;
}

export function JournalForm({ symbol, interval, score, tier }: JournalFormProps) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<(typeof JOURNAL_ACTIONS)[number]>('hold');
  const [notes, setNotes] = useState('');
  const createEntry = useCreateJournalEntry();

  const handleSubmit = () => {
    createEntry.mutate(
      {
        symbol,
        interval,
        signalScore: score,
        signalTier: tier,
        action,
        notes: notes || undefined,
      },
      {
        onSuccess: () => {
          setOpen(false);
          setNotes('');
          setAction('hold');
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="text-xs" data-testid="log-journal-button">
          <BookOpen className="mr-1 size-3.5" />
          Log to Journal
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Log Signal to Journal</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">{symbol}</span>
            <span className="text-muted-foreground">{interval}</span>
            <span className="font-mono tabular-nums">Score: {Math.round(score)}</span>
            <span className="capitalize text-muted-foreground">{tier.replace('_', ' ')}</span>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Action</Label>
            <div className="flex gap-1">
              {JOURNAL_ACTIONS.map((a) => (
                <Button
                  key={a}
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

          <div className="space-y-1">
            <Label className="text-xs">Notes (optional)</Label>
            <Textarea
              value={notes}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)}
              placeholder="Why did you choose this action?"
              className="text-xs"
              rows={3}
              maxLength={1000}
              data-testid="journal-notes"
            />
          </div>

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
