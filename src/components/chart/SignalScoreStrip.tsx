'use client';

import type { TradingStyle } from '@/lib/models/signal-template';
import { tierDisplayLabel } from '@/lib/signals/tier-labels';
import { stylesForInterval } from '@/lib/signals/provisional/styles';
import { evidenceFor } from '@/lib/trade-plan/evidence';
import type { ProvisionalSignalState, ProvisionalStatus } from '@/hooks/useProvisionalSignal';
import { cn } from '@/lib/utils';

export const STRIP_STYLE_LABELS: Record<TradingStyle, string> = {
  scalping: 'Scalping',
  day_trading: 'Day trading',
  swing_trading: 'Swing',
  position_trading: 'Position',
};

/** The style the hook runs with: the user's pick at 1d, else the interval's first style. */
export function resolveStyle(interval: string, chosen: TradingStyle | null): TradingStyle | null {
  const styles = stylesForInterval(interval);
  if (interval === '1d' && chosen && styles.includes(chosen)) return chosen;
  return styles[0] ?? null;
}

/** Status words only, so a changing value never re-announces. */
const ANNOUNCEMENTS: Record<ProvisionalStatus, string> = {
  unavailable: 'No scheduler score for this chart.',
  loading: 'Loading signal inputs.',
  waiting: 'Waiting for signal inputs.',
  provisional: 'Provisional score is live.',
  'awaiting-record': 'Bar closed. Waiting for the recorded score.',
  recorded: 'Recorded score received.',
  'no-record': 'No recorded score arrived for the last bar.',
};

interface SignalScoreStripProps {
  symbol: string;
  interval: string;
  style: TradingStyle | null;
  signal: ProvisionalSignalState;
  onStyleChange: (style: TradingStyle) => void;
}

function Num({ children }: { children: React.ReactNode }) {
  return <span className="font-mono tabular-nums">{children}</span>;
}

function StatusLine({ symbol, interval, signal }: Pick<SignalScoreStripProps, 'symbol' | 'interval' | 'signal'>) {
  const { status, provisional, recorded } = signal;
  switch (status) {
    case 'provisional':
      return provisional ? (
        <>
          Provisional <Num>{provisional.score.toFixed(1)}</Num> · {tierDisplayLabel(provisional.tier)} ·{' '}
          <Num>{Math.round(provisional.confidence)}%</Num> data coverage
        </>
      ) : null;
    case 'awaiting-record':
      return <>Bar closed. Waiting for the scheduler&apos;s recorded score.</>;
    case 'recorded': {
      const latest = [...recorded.entries()].sort((a, b) => b[0] - a[0])[0]?.[1];
      return latest ? (
        <>
          Recorded <Num>{latest.score.toFixed(1)}</Num> · {tierDisplayLabel(latest.tier)}
        </>
      ) : null;
    }
    case 'no-record':
      return <>No recorded score arrived for the last bar.</>;
    case 'waiting':
      switch (signal.reasonCode) {
        case 'awaiting-candle-sync':
          return <>Waiting for the last closed bar to sync.</>;
        case 'insufficient-history':
          return <>Not enough history at this interval.</>;
        case 'version-mismatch':
          return <>The scorer was updated. Reload the page to see provisional scores.</>;
        case 'awaiting-price':
          return <>Waiting for the next price update.</>;
        default:
          return <>{signal.reason ? `${signal.reason.replace(/\.$/, '')}.` : 'Waiting for signal inputs.'}</>;
      }
    case 'loading':
      return <>Loading signal inputs.</>;
    case 'unavailable':
      return (
        <>
          No scheduler score for {symbol} at {interval}.
        </>
      );
  }
}

export function SignalScoreStrip({ symbol, interval, style, signal, onStyleChange }: SignalScoreStripProps) {
  const styles = stylesForInterval(interval);
  const showToggle = interval === '1d' && styles.length > 1;
  const version = signal.configVersion ?? 'unknown';

  return (
    <div
      data-testid="signal-score-strip"
      className="mt-2 space-y-1 rounded-sm border border-border bg-card px-3 py-2 text-xs text-muted-foreground"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">
          Signal score{style ? ` · ${STRIP_STYLE_LABELS[style]}` : ''} · {interval}
        </h3>
        {showToggle && (
          <div role="group" aria-label="Trading style" className="inline-flex overflow-hidden rounded-sm border border-border">
            {styles.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={style === s}
                onClick={() => onStyleChange(s)}
                className={cn(
                  'cursor-pointer px-2.5 py-1 text-xs transition-colors',
                  style === s ? 'bg-accent text-accent-foreground' : 'hover:bg-muted hover:text-foreground'
                )}
              >
                {STRIP_STYLE_LABELS[s]}
              </button>
            ))}
          </div>
        )}
      </div>
      <p>
        Filled bars are the scheduler&apos;s recorded scores (configVersion <Num>{version}</Num>). The hollow bar
        is provisional: it repaints until the bar closes and is never recorded.
      </p>
      <p data-testid="signal-score-status" className="text-foreground">
        <StatusLine symbol={symbol} interval={interval} signal={signal} />
      </p>
      <p>
        Measured record at {interval}: {evidenceFor(interval).verdict}
      </p>
      <p className="sr-only" aria-live="polite" data-testid="signal-score-live">
        {ANNOUNCEMENTS[signal.status]}
      </p>
    </div>
  );
}
