import type { TradingStyle } from '@/lib/models/signal-template';

export const STYLE_LABELS: Record<TradingStyle, string> = {
  scalping: 'Scalping',
  day_trading: 'Day trading',
  swing_trading: 'Swing trading',
  position_trading: 'Position trading',
};

export const INTERVAL_WORDS: Record<string, string> = {
  '5m': '5 minutes',
  '15m': '15 minutes',
  '1h': '1 hour',
  '4h': '4 hours',
  '1d': '1 day',
};

export function bookTitle(book: string): string {
  if (!book) return '';
  const colonIndex = book.indexOf(':');
  if (colonIndex === -1) {
    return (STYLE_LABELS as Record<string, string>)[book] ?? INTERVAL_WORDS[book] ?? book;
  }
  const rawStyle = book.slice(0, colonIndex);
  const rawInterval = book.slice(colonIndex + 1);

  const styleLabel = (STYLE_LABELS as Record<string, string>)[rawStyle] ?? rawStyle;
  const intervalLabel = INTERVAL_WORDS[rawInterval] ?? rawInterval;

  return `${styleLabel}, ${intervalLabel}`;
}
