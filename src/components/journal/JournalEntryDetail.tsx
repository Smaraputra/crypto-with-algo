'use client';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { MarkdownPreview } from './MarkdownPreview';
import { ReviewDialog } from './ReviewDialog';
import type { JournalEntry } from '@/types/journal';
import type { IndicatorSnapshot } from '@/types/indicator-snapshot';

interface JournalEntryDetailProps {
  entry: JournalEntry;
}

const ACTION_COLORS: Record<string, string> = {
  buy: 'bg-green-500/20 text-green-400',
  sell: 'bg-red-500/20 text-red-400',
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
  const pnl = entry.outcomePnlPercent;
  const pnlColor =
    pnl != null
      ? pnl > 0
        ? 'text-green-400'
        : pnl < 0
          ? 'text-red-400'
          : 'text-muted-foreground'
      : 'text-muted-foreground';

  const snapshot = entry.indicatorSnapshot;
  const isReviewed = entry.reviewedAt != null;
  const needsReview = entry.exitPrice != null && !isReviewed;

  return (
    <Card data-testid="journal-entry-detail">
      <CardHeader className="px-4 py-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{entry.symbol.replace('USDT', '')}</span>
            <Badge className={`text-[10px] ${ACTION_COLORS[entry.action]}`}>
              {entry.action.toUpperCase()}
            </Badge>
            <span className="text-[10px] text-muted-foreground">{entry.interval}</span>
            {entry.setupType && (
              <Badge variant="outline" className="text-[10px]">
                {entry.setupType}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isReviewed && (
              <Badge variant="secondary" className="text-[10px]">
                Reviewed
              </Badge>
            )}
            {needsReview && <ReviewDialog entry={entry} />}
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
              {new Date(entry.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-3 pt-0 space-y-3">
        {/* Price and Signal Info */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-muted-foreground">
            Score:{' '}
            <span className="font-mono tabular-nums">{Math.round(entry.signalScore)}</span>
          </span>
          <span className="text-muted-foreground capitalize">
            {entry.signalTier.replace('_', ' ')}
          </span>
          {entry.entryPrice != null && (
            <span className="text-muted-foreground">
              Entry:{' '}
              <span className="font-mono tabular-nums">
                ${entry.entryPrice.toLocaleString()}
              </span>
            </span>
          )}
          {entry.exitPrice != null && (
            <span className="text-muted-foreground">
              Exit:{' '}
              <span className="font-mono tabular-nums">
                ${entry.exitPrice.toLocaleString()}
              </span>
            </span>
          )}
          {pnl != null && (
            <span className={`font-mono tabular-nums ${pnlColor}`}>
              {pnl > 0 ? '+' : ''}
              {pnl.toFixed(2)}%
            </span>
          )}
        </div>

        {/* Market Condition & Sentiment */}
        {(entry.marketCondition || entry.sentiment) && (
          <div className="flex items-center gap-3 text-xs">
            {entry.marketCondition && (
              <span className="text-muted-foreground">
                Market: {MARKET_CONDITION_LABELS[entry.marketCondition] ?? entry.marketCondition}
              </span>
            )}
            {entry.sentiment && (
              <span className="text-muted-foreground">
                F&G: <span className="font-mono tabular-nums">{entry.sentiment.fearGreedIndex}</span>{' '}
                ({entry.sentiment.fearGreedLabel})
              </span>
            )}
          </div>
        )}

        {/* Tags */}
        {entry.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {entry.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-[10px]">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        {/* Notes */}
        {entry.notes && (
          <div className="border-t border-border/50 pt-2">
            <MarkdownPreview content={entry.notes} />
          </div>
        )}

        {/* Lessons Learned */}
        {entry.lessonsLearned && (
          <div className="border-t border-border/50 pt-2">
            <p className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider">
              Lessons Learned
            </p>
            <p className="text-xs text-muted-foreground">{entry.lessonsLearned}</p>
          </div>
        )}

        {/* Indicator Snapshot */}
        {snapshot && (
          <div className="border-t border-border/50 pt-2">
            <p className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider">
              Indicator Snapshot
            </p>
            <div className="grid grid-cols-4 gap-x-3 gap-y-0.5 text-[10px]">
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
                        ? 'text-green-400'
                        : 'text-red-400'
                    }
                  >
                    {snapshot.superTrendDirection === 'up' ? 'Bullish' : 'Bearish'}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
