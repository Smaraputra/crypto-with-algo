'use client';

import {
  TRADE_EMOTION_LABELS,
  TRADE_MISTAKE_LABELS,
  type TradeEmotion,
  type TradeMistake,
} from '@/types/journal';
import { cn } from '@/lib/utils';
import type {
  EmotionPerformance,
  MistakePerformance,
  TradeStreaks,
} from '@/types/journal-analytics';

import { formatWinRate, formatAvgPnl, avgPnlColorClass } from './format';

interface PsychologyAnalyticsProps {
  byEmotion: EmotionPerformance[];
  byMistake: MistakePerformance[];
  streaks: TradeStreaks;
}

function PnlValue({ value }: { value: number | null }) {
  return (
    <span className={cn('font-mono tabular-nums', avgPnlColorClass(value))}>
      {formatAvgPnl(value)}
    </span>
  );
}

export function PsychologyAnalytics({ byEmotion, byMistake, streaks }: PsychologyAnalyticsProps) {
  const hasData = byEmotion.length > 0 || byMistake.length > 0 || streaks.current !== null;

  if (!hasData) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="psychology-empty">
        No psychology data yet. Log emotions when entering trades and mistakes when closing them.
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="psychology-analytics">
      {/* Streaks */}
      <div className="flex flex-wrap gap-4 text-xs" data-testid="streaks-row">
        {streaks.current && (
          <span
            className={cn(
              streaks.current.type === 'win' ? 'text-bullish' : 'text-bearish'
            )}
            data-testid="current-streak"
          >
            Current streak: {streaks.current.length}{' '}
            {streaks.current.type === 'win' ? 'wins' : 'losses'}
          </span>
        )}
        <span className="text-muted-foreground">
          Best run: <span className="font-mono tabular-nums">{streaks.maxWinStreak}</span> wins
        </span>
        <span className="text-muted-foreground">
          Worst run: <span className="font-mono tabular-nums">{streaks.maxLossStreak}</span> losses
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h4 className="mb-2 text-xs font-medium text-muted-foreground">Win Rate by Emotion</h4>
          {byEmotion.length === 0 ? (
            <p className="text-xs text-muted-foreground">No emotions logged yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {byEmotion.map((entry) => (
                <li key={entry.emotion} className="flex items-center justify-between text-xs">
                  <span>{TRADE_EMOTION_LABELS[entry.emotion as TradeEmotion] ?? entry.emotion}</span>
                  <span className="flex items-center gap-3">
                    <span className="text-muted-foreground">{entry.count} trades</span>
                    <span className="font-mono tabular-nums">{formatWinRate(entry.winRate, 0)}</span>
                    <PnlValue value={entry.avgPnlPercent} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h4 className="mb-2 text-xs font-medium text-muted-foreground">Cost of Mistakes</h4>
          {byMistake.length === 0 ? (
            <p className="text-xs text-muted-foreground">No mistakes logged yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {byMistake.map((entry) => (
                <li key={entry.mistake} className="flex items-center justify-between text-xs">
                  <span>{TRADE_MISTAKE_LABELS[entry.mistake as TradeMistake] ?? entry.mistake}</span>
                  <span className="flex items-center gap-3">
                    <span className="text-muted-foreground">{entry.count}x</span>
                    <PnlValue value={entry.totalPnlPercent} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
