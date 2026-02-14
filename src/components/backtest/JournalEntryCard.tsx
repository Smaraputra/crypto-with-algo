'use client';

import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { JournalEntry } from '@/types/journal';

interface JournalEntryCardProps {
  entry: JournalEntry;
  onDelete: (id: string) => void;
  isDeleting: boolean;
}

const ACTION_COLORS: Record<string, string> = {
  buy: 'bg-bullish-muted text-bullish',
  sell: 'bg-bearish-muted text-bearish',
  hold: 'bg-yellow-500/20 text-yellow-400',
  skip: 'bg-muted text-muted-foreground',
};

export function JournalEntryCard({ entry, onDelete, isDeleting }: JournalEntryCardProps) {
  const pnlColor =
    entry.outcomePnlPercent != null
      ? entry.outcomePnlPercent > 0
        ? 'text-bullish'
        : entry.outcomePnlPercent < 0
          ? 'text-bearish'
          : 'text-muted-foreground'
      : 'text-muted-foreground';

  return (
    <Card className="p-0" data-testid="journal-entry-card">
      <CardContent className="px-3 py-2.5">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{entry.symbol.replace('USDT', '')}</span>
              <Badge className={`text-xs ${ACTION_COLORS[entry.action]}`}>
                {entry.action.toUpperCase()}
              </Badge>
              <span className="text-xs text-muted-foreground">{entry.interval}</span>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="text-muted-foreground">
                Score: <span className="font-mono tabular-nums">{Math.round(entry.signalScore)}</span>
              </span>
              <span className="text-muted-foreground capitalize">
                {entry.signalTier.replace('_', ' ')}
              </span>
              {entry.entryPrice != null && (
                <span className="text-muted-foreground">
                  Entry: <span className="font-mono tabular-nums">${entry.entryPrice.toLocaleString()}</span>
                </span>
              )}
              {entry.exitPrice != null && (
                <span className="text-muted-foreground">
                  Exit: <span className="font-mono tabular-nums">${entry.exitPrice.toLocaleString()}</span>
                </span>
              )}
              {entry.outcomePnlPercent != null && (
                <span className={`font-mono tabular-nums ${pnlColor}`}>
                  {entry.outcomePnlPercent > 0 ? '+' : ''}
                  {entry.outcomePnlPercent.toFixed(2)}%
                </span>
              )}
            </div>
            {entry.notes && (
              <p className="text-xs text-muted-foreground truncate">{entry.notes}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {new Date(entry.createdAt).toLocaleDateString()}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => onDelete(entry._id)}
              disabled={isDeleting}
              aria-label={`Delete journal entry`}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
