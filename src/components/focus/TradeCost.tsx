'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { marketProblemText } from '@/components/cost-check/market-problem';
import { useCostCheckMarket } from '@/hooks/useCostCheck';
import { computeFocusCost } from '@/lib/costs/focus-cost';
import {
  HOLD_PRESETS,
  notionalOf,
  parseStoredInputs,
  STORAGE_KEY,
  type CostCheckInputs,
} from '@/lib/costs/cost-check-model';
import { pickMeasurementInterval } from '@/lib/costs/move';
import { cn } from '@/lib/utils';
import { EvidenceTag } from './EvidenceTag';
import { formatAge } from './format';

export interface TradeCostProps {
  symbol: string;
  interval: '15m' | '1h';
  className?: string;
}

const HOLD_OPTIONS = HOLD_PRESETS.filter((p) =>
  ['15m', '1h', '4h', '1d'].includes(p.label)
);

/** Storage can be blocked (private mode, disabled site data) and the defaults then apply. */
function readSavedInputs(): CostCheckInputs {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  return parseStoredInputs(raw);
}

export function TradeCost({ symbol, interval, className }: TradeCostProps) {
  const headingId = useId();
  const [inputs] = useState<CostCheckInputs>(() => readSavedInputs());
  const [holdMinutes, setHoldMinutes] = useState(
    interval === '15m' ? 15 : 60
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const notional = notionalOf(inputs);
  const market = useCostCheckMarket(symbol, holdMinutes, notional);

  const expected = pickMeasurementInterval(holdMinutes * 60_000);
  const data = market.data;
  const marketData =
    data &&
    data.symbol === symbol &&
    data.measurement.interval === expected.interval &&
    data.measurement.holdBars === expected.holdBars
      ? data
      : null;

  const cost = useMemo(
    () => computeFocusCost(inputs, marketData, holdMinutes, now),
    [inputs, marketData, holdMinutes, now]
  );

  const holdLabel =
    HOLD_PRESETS.find((p) => p.minutes === holdMinutes)?.label ??
    `${holdMinutes}m`;

  const feeLabel =
    inputs.feeTier === 'bnb'
      ? 'BNB-discount'
      : inputs.feeTier === 'custom'
        ? `custom (${inputs.customMakerPercent}% maker, ${inputs.customTakerPercent}% taker)`
        : 'standard';

  const notionalText = cost.notional.toLocaleString('en-US', {
    maximumFractionDigits: 2,
  });

  const minText = (cost.effectiveMinNotional ?? 0).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  });

  const slippageSourceText =
    cost.slippageSource === 'depth'
      ? 'from the order book'
      : cost.slippageSource === 'override'
        ? 'your Cost Check setting'
        : 'a flat estimate';

  const f = cost.funding;
  let fundingText = '';
  if (f) {
    if (f.payer === null) {
      fundingText = 'Funding 0% per settlement.';
    } else if (f.settlements === 0) {
      fundingText = `No funding settlement in a ${holdLabel} hold from now.`;
    } else {
      const sign = f.payer === 'longs' ? '+' : '-';
      const settlementsWord =
        f.settlements === 1 ? 'settlement' : 'settlements';
      fundingText = `Funding ${sign}${Math.abs(f.ratePercent).toFixed(4)}% per settlement, ${f.payer} pay. ${f.settlements} ${settlementsWord} in a ${holdLabel} hold, not included above.`;
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      data-testid="trade-cost"
      className={cn('space-y-3 p-4', className)}
    >
      <div className="flex items-center justify-between">
        <h3 id={headingId} className="text-sm font-semibold">
          Round-trip cost
        </h3>
        <EvidenceTag kind="context" />
      </div>

      <div
        role="group"
        aria-label="Hold length"
        className="flex flex-wrap gap-1"
      >
        {HOLD_OPTIONS.map((option) => {
          const active = option.minutes === holdMinutes;
          return (
            <Button
              key={option.label}
              size="xs"
              variant={active ? 'secondary' : 'outline'}
              aria-pressed={active}
              className="min-h-11 min-w-11 sm:min-h-6 sm:min-w-0"
              onClick={() => setHoldMinutes(option.minutes)}
            >
              {option.label}
            </Button>
          );
        })}
      </div>

      {!marketData && !market.isError && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading costs for {symbol}...
        </p>
      )}

      {!marketData && market.isError && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive">
            Could not load costs: {marketProblemText(market.error?.code)}.
          </p>
          <Button
            variant="outline"
            size="xs"
            className="min-h-11 sm:min-h-6"
            onClick={() => void market.refetch()}
          >
            Retry
          </Button>
        </div>
      )}

      {marketData && (
        <>
          <p className="text-xs text-muted-foreground">
            {notionalText} USDT, {feeLabel} fees, held {holdLabel}.
          </p>

          <table className="w-full text-xs">
            <caption className="sr-only">
              Round-trip cost of a {holdLabel} hold on {symbol}, by fill type
            </caption>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="text-left font-normal text-muted-foreground"
                >
                  Fills
                </th>
                <th
                  scope="col"
                  className="pl-3 text-right font-normal text-muted-foreground"
                >
                  Cost
                </th>
                <th
                  scope="col"
                  className="pl-3 text-right font-normal text-muted-foreground"
                >
                  Break-even win rate
                </th>
              </tr>
            </thead>
            <tbody>
              {cost.rows.map((row, index) => {
                let winRateText = 'Not measured';
                if (row.breakeven !== null) {
                  if (row.breakeven.kind === 'possible') {
                    winRateText = `${(row.breakeven.winRate * 100).toFixed(1)}%`;
                  } else if (row.breakeven.kind === 'impossible') {
                    winRateText = 'Not reachable';
                  }
                }

                return (
                  <tr key={row.label} data-testid="trade-cost-row">
                    <th scope="row" className="py-1 pr-2 text-left font-normal">
                      {row.label}
                    </th>
                    <td className="py-1 pl-3 text-right font-mono tabular-nums">
                      {row.costPercent.toFixed(3)}%
                      <span className="block text-muted-foreground">
                        {row.costUsdt.toFixed(2)} USDT
                      </span>
                    </td>
                    <td
                      className={cn(
                        'py-1 pl-3 text-right font-mono tabular-nums',
                        index === 0 && 'font-semibold text-foreground'
                      )}
                    >
                      {winRateText}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p className="text-xs text-muted-foreground">
            {!cost.moveIsThin && cost.move
              ? `Typical ${holdLabel} move: ${cost.move.meanPercent.toFixed(2)}% (mean of ${cost.move.independentWindows} windows).`
              : `Too little history to measure the typical ${holdLabel} move, so no win rate is shown.`}
          </p>

          {f && (
            <p className="text-xs text-muted-foreground">
              {fundingText}
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            {cost.slippageBps < 0.05
              ? `Slippage under 0.1 bps per taker leg, ${slippageSourceText}.`
              : `Slippage ${cost.slippageBps.toFixed(1)} bps per taker leg, ${slippageSourceText}.`}{' '}
            Maker rows assume your resting order fills. It fills most often when
            price moves against you.
          </p>

          {cost.belowMinNotional && (
            <p className="text-xs text-destructive">
              {`${notionalText} USDT is below this perpetual's minimum order of ${minText} USDT.`}
            </p>
          )}

          {marketData.stale && (
            <p className="text-xs text-muted-foreground">
              Binance could not be reached. These figures are from{' '}
              {formatAge(marketData.asOf)}.
            </p>
          )}

          <Link
            href={`/cost-check?symbol=${symbol}&holdMinutes=${holdMinutes}`}
            className="inline-flex min-h-11 items-center text-xs underline underline-offset-2 sm:min-h-0"
          >
            Change size or fees in Cost Check
          </Link>
        </>
      )}
    </section>
  );
}
