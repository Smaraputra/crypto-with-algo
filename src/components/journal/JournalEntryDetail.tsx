'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownPreview } from './MarkdownPreview';
import { ReviewDialog } from './ReviewDialog';
import { CloseTradeDialog } from './CloseTradeDialog';
import { EntryActions } from './EntryActions';
import { TagInput } from './TagInput';
import { useUpdateJournalEntry } from '@/hooks/useJournal';
import type { JournalEntry, MarketCondition } from '@/types/journal';
import type { IndicatorSnapshot } from '@/types/indicator-snapshot';

interface JournalEntryDetailProps {
  entry: JournalEntry;
}

const ACTION_COLORS: Record<string, string> = {
  buy: 'bg-bullish-muted text-bullish',
  sell: 'bg-bearish-muted text-bearish',
  hold: 'bg-yellow-500/20 text-yellow-400',
  skip: 'bg-muted text-muted-foreground',
};

const MARKET_CONDITION_LABELS: Record<string, string> = {
  trending_up: 'Trending Up',
  trending_down: 'Trending Down',
  ranging: 'Ranging',
  volatile: 'Volatile',
  calm: 'Calm',
};

const MARKET_CONDITION_OPTIONS: MarketCondition[] = [
  'trending_up',
  'trending_down',
  'ranging',
  'volatile',
  'calm',
];

const SNAPSHOT_LABELS: Partial<Record<keyof IndicatorSnapshot, string>> = {
  rsi: 'RSI',
  macdLine: 'MACD',
  macdSignal: 'Signal',
  macdHistogram: 'Histogram',
  ema12: 'EMA12',
  ema26: 'EMA26',
  sma50: 'SMA50',
  sma200: 'SMA200',
  atr: 'ATR',
  stochRsiK: 'StochRSI K',
  stochRsiD: 'StochRSI D',
  williamsR: 'Williams %R',
  mfi: 'MFI',
  obv: 'OBV',
};

function formatSnapshotValue(key: string, value: unknown): string {
  if (value == null) return '-';
  if (typeof value === 'number') {
    if (key === 'obv') return value.toLocaleString();
    return value.toFixed(2);
  }
  return String(value);
}

export function JournalEntryDetail({ entry }: JournalEntryDetailProps) {
  const [editing, setEditing] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [snapshotExpanded, setSnapshotExpanded] = useState(false);
  const [editNotes, setEditNotes] = useState(entry.notes);
  const [editTags, setEditTags] = useState(entry.tags);
  const [editSetupType, setEditSetupType] = useState(entry.setupType);
  const [editMarketCondition, setEditMarketCondition] = useState<string>(
    entry.marketCondition || ''
  );
  const updateMutation = useUpdateJournalEntry();

  const pnl = entry.outcomePnlPercent;
  const pnlColor =
    pnl != null
      ? pnl > 0
        ? 'text-bullish'
        : pnl < 0
          ? 'text-bearish'
          : 'text-muted-foreground'
      : 'text-muted-foreground';

  const snapshot = entry.indicatorSnapshot;
  const isReviewed = entry.reviewedAt != null;
  const needsReview = entry.exitPrice != null && !isReviewed;
  const isOpenTrade = entry.entryPrice != null && entry.exitPrice == null;

  function handleSaveEdit() {
    updateMutation.mutate(
      {
        id: entry._id,
        notes: editNotes,
        tags: editTags,
        setupType: editSetupType,
        marketCondition: (editMarketCondition || undefined) as MarketCondition | undefined,
      },
      { onSuccess: () => setEditing(false) }
    );
  }

  function handleCancelEdit() {
    setEditNotes(entry.notes);
    setEditTags(entry.tags);
    setEditSetupType(entry.setupType);
    setEditMarketCondition(entry.marketCondition || '');
    setEditing(false);
  }

  return (
    <Card data-testid="journal-entry-detail">
      {/* Header: Symbol + Action + Date + Actions */}
      <CardHeader className="px-4 py-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{entry.symbol.replace('USDT', '')}</span>
            <Badge className={`text-xs ${ACTION_COLORS[entry.action]}`}>
              {entry.action.toUpperCase()}
            </Badge>
            <span className="text-xs text-muted-foreground">{entry.interval}</span>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {new Date(entry.createdAt).toLocaleDateString()}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {isReviewed && (
              <Badge variant="secondary" className="text-xs">
                Reviewed
              </Badge>
            )}
            {needsReview && <ReviewDialog entry={entry} />}
            {isOpenTrade && <CloseTradeDialog entry={entry} />}
            <EntryActions entry={entry} onEdit={() => setEditing(true)} />
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-3 pt-0 space-y-3">
        {/* Price Row (prominent) */}
        {(entry.entryPrice != null || pnl != null) && (
          <div className="flex flex-wrap items-baseline gap-4">
            {entry.entryPrice != null && (
              <div className="text-xs text-muted-foreground">
                Entry{' '}
                <span className="text-sm font-mono tabular-nums text-foreground">
                  ${entry.entryPrice.toLocaleString()}
                </span>
              </div>
            )}
            {entry.exitPrice != null && (
              <div className="text-xs text-muted-foreground">
                Exit{' '}
                <span className="text-sm font-mono tabular-nums text-foreground">
                  ${entry.exitPrice.toLocaleString()}
                </span>
              </div>
            )}
            {pnl != null && (
              <span
                className={`text-base font-semibold font-mono tabular-nums ${pnlColor}`}
                data-testid="entry-pnl"
              >
                {pnl > 0 ? '+' : ''}
                {pnl.toFixed(2)}%
              </span>
            )}
          </div>
        )}

        {/* Context Row (small, muted) */}
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>
            Score: <span className="font-mono tabular-nums">{Math.round(entry.signalScore)}</span>
          </span>
          <span className="capitalize">{entry.signalTier.replace('_', ' ')}</span>
          {!editing && entry.setupType && (
            <Badge variant="outline" className="text-xs">
              {entry.setupType}
            </Badge>
          )}
          {!editing && entry.marketCondition && (
            <span>
              {MARKET_CONDITION_LABELS[entry.marketCondition] ?? entry.marketCondition}
            </span>
          )}
          {entry.sentiment && (
            <span>
              F&G: <span className="font-mono tabular-nums">{entry.sentiment.fearGreedIndex}</span>{' '}
              ({entry.sentiment.fearGreedLabel})
            </span>
          )}
        </div>

        {/* Inline Edit Mode */}
        {editing && (
          <div className="space-y-2 border border-border/50 rounded-md p-3" data-testid="inline-edit-form">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground uppercase tracking-wider">
                Setup Type
              </label>
              <Input
                value={editSetupType}
                onChange={(e) => setEditSetupType(e.target.value)}
                placeholder="e.g. breakout, reversal"
                className="h-8 text-xs"
                data-testid="edit-setup-type"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground uppercase tracking-wider">
                Market Condition
              </label>
              <select
                value={editMarketCondition}
                onChange={(e) => setEditMarketCondition(e.target.value)}
                className="flex h-8 w-full rounded-md border border-input bg-background px-3 text-xs"
                data-testid="edit-market-condition"
              >
                <option value="">None</option>
                {MARKET_CONDITION_OPTIONS.map((mc) => (
                  <option key={mc} value={mc}>
                    {MARKET_CONDITION_LABELS[mc]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground uppercase tracking-wider">
                Tags
              </label>
              <TagInput value={editTags} onChange={setEditTags} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground uppercase tracking-wider">
                Notes
              </label>
              <Textarea
                value={editNotes}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditNotes(e.target.value)}
                className="text-xs min-h-[60px]"
                rows={3}
                data-testid="edit-notes"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                size="xs"
                variant="ghost"
                onClick={handleCancelEdit}
              >
                Cancel
              </Button>
              <Button
                size="xs"
                onClick={handleSaveEdit}
                disabled={updateMutation.isPending}
                data-testid="save-edit-button"
              >
                {updateMutation.isPending ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        )}

        {/* Tags (view mode) */}
        {!editing && entry.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {entry.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        {/* Collapsible Notes */}
        {!editing && entry.notes && (
          <div className="border-t border-border/50 pt-2">
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
              onClick={() => setNotesExpanded((prev) => !prev)}
              data-testid="toggle-notes"
            >
              {notesExpanded ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              Notes
            </button>
            {notesExpanded && (
              <div className="mt-1">
                <MarkdownPreview content={entry.notes} />
              </div>
            )}
          </div>
        )}

        {/* Lessons Learned */}
        {entry.lessonsLearned && (
          <div className="border-t border-border/50 pt-2">
            <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">
              Lessons Learned
            </p>
            <p className="text-xs text-muted-foreground">{entry.lessonsLearned}</p>
          </div>
        )}

        {/* Collapsible Indicator Snapshot */}
        {snapshot && (
          <div className="border-t border-border/50 pt-2">
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
              onClick={() => setSnapshotExpanded((prev) => !prev)}
              data-testid="toggle-snapshot"
            >
              {snapshotExpanded ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              Indicator Snapshot
            </button>
            {snapshotExpanded && (
              <div className="grid grid-cols-4 gap-x-3 gap-y-0.5 text-xs mt-1">
                {(Object.entries(SNAPSHOT_LABELS) as [keyof IndicatorSnapshot, string][]).map(
                  ([key, label]) => {
                    const val = snapshot[key];
                    if (val == null) return null;
                    return (
                      <div key={key} className="flex justify-between">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-mono tabular-nums">
                          {formatSnapshotValue(key, val)}
                        </span>
                      </div>
                    );
                  }
                )}
                {snapshot.superTrendDirection && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">SuperTrend</span>
                    <span
                      className={
                        snapshot.superTrendDirection === 'up'
                          ? 'text-bullish'
                          : 'text-bearish'
                      }
                    >
                      {snapshot.superTrendDirection === 'up' ? 'Bullish' : 'Bearish'}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
