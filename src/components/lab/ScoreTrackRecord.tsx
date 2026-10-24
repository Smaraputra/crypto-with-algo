'use client';

import React, { useId, useState } from 'react';
import { Panel } from '@/components/kit/Panel';
import { SegmentedControl } from '@/components/kit/SegmentedControl';
import { StateNotice } from '@/components/kit/StateNotice';
import { useTrackRecord } from '@/hooks/useTrackRecord';
import type { TradingStyle } from '@/lib/models/signal-template';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/uiStore';

export interface ScoreTrackRecordProps {
  className?: string;
}

interface CellOption {
  value: string;
  label: string;
  interval: string;
  style: TradingStyle;
}

const CELL_OPTIONS: CellOption[] = [
  { value: '5m:scalping', label: '5 minutes', interval: '5m', style: 'scalping' },
  { value: '15m:day_trading', label: '15 minutes', interval: '15m', style: 'day_trading' },
  { value: '1h:day_trading', label: '1 hour', interval: '1h', style: 'day_trading' },
  { value: '4h:swing_trading', label: '4 hours', interval: '4h', style: 'swing_trading' },
  { value: '1d:swing_trading', label: 'Daily, swing', interval: '1d', style: 'swing_trading' },
  { value: '1d:position_trading', label: 'Daily, position', interval: '1d', style: 'position_trading' },
];

function formatPercent(val: number | null): string {
  if (val === null || !Number.isFinite(val)) return 'n/a';
  return `${(val * 100).toFixed(1)}%`;
}

function formatSignedPercent(val: number | null): string {
  if (val === null || !Number.isFinite(val)) return 'n/a';
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}%`;
}

function formatTrackDate(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'n/a';
  const d = new Date(ms);
  const day = d.getUTCDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

function toRulerPercent(val: number): number {
  const pct = ((val - 0.3) / (0.7 - 0.3)) * 100;
  return Math.max(0, Math.min(100, pct));
}

export const ScoreTrackRecord: React.FC<ScoreTrackRecordProps> = ({ className }) => {
  const coinSelectId = useId();
  const coinSelectRef = React.useRef<HTMLSelectElement>(null);
  const initialSymbol = useUIStore((s) => s.selectedSymbol);

  const [symbol, setSymbol] = useState<string>(() =>
    (SIGNAL_SYMBOLS as readonly string[]).includes(initialSymbol) ? initialSymbol : 'BTCUSDT'
  );
  const [cellKey, setCellKey] = useState<string>('1h:day_trading');

  const activeCell = CELL_OPTIONS.find((c) => c.value === cellKey) ?? CELL_OPTIONS[2];

  const { data, isLoading, isError, refetch } = useTrackRecord(
    symbol,
    activeCell.interval,
    activeCell.style
  );

  const hasRows = Boolean(
    data &&
      data.available &&
      data.symbol &&
      data.symbol.measures.calls > 0 &&
      data.symbol.measures.bh !== null
  );

  return (
    <Panel title="Price score track record" className={cn('flex flex-col', className)}>
      <div className="space-y-4 mb-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={coinSelectId} className="text-[13px] font-medium text-muted-foreground">
            Coin
          </label>
          <select
            ref={coinSelectRef}
            id={coinSelectId}
            aria-label="Coin"
            value={symbol}
            onChange={() => {
              if (coinSelectRef.current) {
                setSymbol(coinSelectRef.current.value);
              }
            }}
            className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-semibold text-[14px] cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {SIGNAL_SYMBOLS.map((s) => (
              <option key={s} value={s}>
                {s.replace(/USDT$/, '')}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <SegmentedControl
            legend="Timeframe"
            options={CELL_OPTIONS}
            value={cellKey}
            onChange={setCellKey}
            className="flex-wrap max-w-full"
          />
        </div>
      </div>

      {isLoading ? (
        <StateNotice kind="loading" title="Loading the track record." />
      ) : isError ? (
        <StateNotice
          kind="error"
          title="The track record did not load."
          action={
            <button
              type="button"
              onClick={() => refetch()}
              className="inline-flex items-center justify-center min-h-[44px] px-4 py-2 rounded-[12px] border border-edge bg-card text-foreground font-semibold text-[13px] hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring cursor-pointer"
            >
              Try again
            </button>
          }
        />
      ) : !hasRows || !data || !data.available || !data.symbol ? (
        <StateNotice kind="empty" title="No track record for this coin and timeframe." />
      ) : (
        (() => {
          const symbolTrack = data.symbol;
          const { measures, intervals } = symbolTrack;
          const bh = measures.bh;
          const x = formatPercent(bh);
          const breakEvenStr = formatPercent(measures.breakEven);

          const rulerLabel = [
            `Balanced hit rate ${x}`,
            'coin flip 50%',
            measures.breakEven !== null ? `break-even ${breakEvenStr}` : null,
            intervals.bh
              ? `95% range ${formatPercent(intervals.bh.lo)} to ${formatPercent(intervals.bh.hi)}`
              : null,
          ]
            .filter(Boolean)
            .join(', ');

          const isTooFew =
            data.live.measures.buyN < 30 || data.live.measures.sellN < 30;

          return (
            <div className="space-y-4">
              <p className="text-[15px] font-medium text-foreground leading-relaxed font-sans tabular-nums">
                {`Right ${x} of the time. A coin flip is right 50%.${
                  measures.breakEven !== null
                    ? ` Breaking even after ${data.cell.costPercent}% costs needed about ${breakEvenStr}.`
                    : ''
                }`}
              </p>

              <div>
                <div
                  role="img"
                  aria-label={rulerLabel}
                  className="relative h-8 my-2 bg-card rounded-[8px] overflow-hidden"
                >
                  <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[2px] bg-edge/30" />
                  {intervals.bh && (
                    <span
                      className="absolute top-1 bottom-1 bg-muted-foreground/15 rounded-[3px]"
                      style={{
                        left: `${toRulerPercent(intervals.bh.lo)}%`,
                        width: `${Math.max(
                          0,
                          toRulerPercent(intervals.bh.hi) - toRulerPercent(intervals.bh.lo)
                        )}%`,
                      }}
                    />
                  )}
                  <span
                    className="absolute top-0 bottom-0 w-[2px] bg-muted-foreground/60 -translate-x-1/2"
                    style={{ left: '50%' }}
                  />
                  {measures.breakEven !== null && (
                    <span
                      className="absolute top-0 bottom-0 w-[2px] bg-ink-2 -translate-x-1/2"
                      style={{ left: `${toRulerPercent(measures.breakEven)}%` }}
                    />
                  )}
                  {bh !== null && (
                    <span
                      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-foreground"
                      style={{ left: `${toRulerPercent(bh)}%` }}
                    />
                  )}
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground font-sans tabular-nums select-none px-0.5">
                  <span>30%</span>
                  <span>50%</span>
                  <span>70%</span>
                </div>
              </div>

              <p
                className={cn(
                  'text-[14px] leading-relaxed font-sans tabular-nums',
                  measures.net !== null && measures.net < 0
                    ? 'text-down'
                    : measures.net !== null && measures.net > 0
                      ? 'text-up'
                      : 'text-muted-foreground'
                )}
              >
                {`Acting on every call returned ${formatSignedPercent(
                  measures.net
                )} per call on average after costs (${
                  intervals.net
                    ? `${formatSignedPercent(intervals.net.lo)} to ${formatSignedPercent(
                        intervals.net.hi
                      )}`
                    : 'n/a'
                }, 95% range).`}
              </p>

              <p className="text-[14px] text-muted-foreground leading-relaxed font-sans tabular-nums">
                {`${measures.calls.toLocaleString()} calls from ${formatTrackDate(
                  symbolTrack.first
                )} to ${formatTrackDate(symbolTrack.last)}.`}
              </p>

              <p className="text-[14px] text-muted-foreground leading-relaxed font-sans tabular-nums">
                {`All ten coins, same timeframe: ${data.cell.pooled.verdict.toLowerCase()}. Right ${formatPercent(
                  data.cell.pooled.bh
                )} (${formatPercent(data.cell.pooled.bhLo)} to ${formatPercent(
                  data.cell.pooled.bhHi
                )}).`}
              </p>

              {data.live.since !== null && (
                <p className="text-[14px] text-muted-foreground leading-relaxed font-sans tabular-nums">
                  {`Live since ${formatTrackDate(
                    data.live.since
                  )}: ${data.live.resolved.toLocaleString()} resolved calls, right ${formatPercent(
                    data.live.measures.right
                  )}, average after costs ${formatSignedPercent(data.live.measures.net)}.${
                    isTooFew
                      ? ' Too few to judge yet: the research needs 30 calls on each side.'
                      : ''
                  }`}
                </p>
              )}
            </div>
          );
        })()
      )}
    </Panel>
  );
};
