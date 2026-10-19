'use client';

import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { useMarketStreamStatus } from '@/hooks/useMarketStream';
import { useBarArrivalLag } from '@/hooks/useBarArrivalLag';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { useDailyLevels } from '@/hooks/useDailyLevels';
import { useSignalLab } from '@/hooks/useSignalLab';
import { useSignalLabV2 } from '@/hooks/useSignalLabV2';
import { useCrossSectionalLatest } from '@/hooks/useSignals';
import { levelProximity, type LevelName } from '@/lib/market/levels';
import { V8_STATUS } from '@/lib/signals/v8-status';
import { statusSentence } from '@/components/market/StreamStatusBadge';
import type { StreamStatus } from '@/lib/market-stream/client';

function noopSubscribe() {
  return () => {};
}

export type NearCoinInput = {
  symbol: string;
  distanceAtr: number;
  level: LevelName;
};

export interface LookReasonsInput {
  status: StreamStatus;
  nearCoins: readonly {
    symbol: string;
    distanceAtr: number;
    level: LevelName;
  }[];
  validatedHypothesisIds: readonly string[];
}

export function formatNearCoinSentence(coin: NearCoinInput): string {
  const base = coin.symbol.replace(/USDT$/, '');
  const abs = Math.abs(coin.distanceAtr).toFixed(1);
  const dir = coin.distanceAtr < 0 ? 'below' : 'above';
  const lvl = `prev ${coin.level}`;
  return `${base} is ${abs} ATR ${dir} the ${lvl}`;
}

export function lookReasons(input: LookReasonsInput): string[] {
  const reasons: string[] = [];
  if (input.status !== 'live') {
    reasons.push(`prices are ${input.status}`);
  }

  for (const coin of input.nearCoins) {
    reasons.push(formatNearCoinSentence(coin));
  }

  for (const id of input.validatedHypothesisIds) {
    reasons.push(`${id} crossed its evidence threshold`);
  }

  return reasons;
}

export function nextLabBarAt(nowMs: number): number {
  const d = new Date(nowMs);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();

  const candidateHours = [0, 8, 16];
  for (const h of candidateHours) {
    const candidate = Date.UTC(year, month, day, h, 3, 0, 0);
    if (candidate > nowMs) {
      return candidate;
    }
  }

  return Date.UTC(year, month, day + 1, 0, 3, 0, 0);
}

export function WhenToLookPanel() {
  const id = useId();
  const isClient = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const { status, lastMessageAt, retry } = useMarketStreamStatus();
  const arrival = useBarArrivalLag();
  const { symbols, isLoading: watchlistLoading } = useWatchlist();
  const { tickers } = useBinanceTicker(symbols);
  const {
    data: levelsData,
    isLoading: levelsLoading,
    isError: levelsError,
  } = useDailyLevels(symbols);
  const {
    data: labData,
    isLoading: labLoading,
    isError: labError,
    refetch: refetchLab,
  } = useSignalLab();
  const {
    data: labV2Data,
    isLoading: labV2Loading,
    isError: labV2Error,
    refetch: refetchLabV2,
  } = useSignalLabV2();
  const {
    data: crossData,
    isLoading: crossLoading,
    isError: crossError,
  } = useCrossSectionalLatest();

  const nearCoins = useMemo(() => {
    if (symbols.length === 0 || !levelsData?.levels) {
      return [];
    }
    const result: Array<{ symbol: string; distanceAtr: number; level: LevelName }> = [];
    for (const symbol of symbols) {
      const ticker = tickers[symbol];
      const price = ticker ? parseFloat(ticker.lastPrice) : NaN;
      const coinLevels = levelsData.levels[symbol];
      if (coinLevels && Number.isFinite(price) && price > 0) {
        const prox = levelProximity(price, coinLevels);
        if (prox && prox.near) {
          result.push({
            symbol,
            distanceAtr: prox.distanceAtr,
            level: prox.level,
          });
        }
      }
    }
    return result;
  }, [symbols, tickers, levelsData]);

  const validatedHypothesisIds = useMemo(() => {
    const v1 = (labData?.hypotheses ?? [])
      .filter((h) => h.status === 'validated')
      .map((h) => h.id);
    const v2 = (labV2Data?.hypotheses ?? [])
      .filter((h) => h.status === 'validated')
      .map((h) => h.id);
    return [...v1, ...v2];
  }, [labData, labV2Data]);

  const reasons = useMemo(
    () => lookReasons({ status, nearCoins, validatedHypothesisIds }),
    [status, nearCoins, validatedHypothesisIds]
  );

  let rvSentence: string | null = null;
  if (!crossLoading && !crossError && crossData?.book?.validationStatus) {
    const rvStatus = crossData.book.validationStatus;
    if (rvStatus === 'rejected') {
      rvSentence = 'rv-v1 relative value: rejected by re-validation.';
    } else if (rvStatus === 'unvalidated') {
      rvSentence = 'rv-v1 relative value: under forward test, not validated.';
    } else if (rvStatus === 'validated') {
      rvSentence = 'rv-v1 relative value: validated.';
    }
  }

  const hypotheses = labData?.hypotheses ?? [];
  const underTest = hypotheses.filter((h) => h.status === 'under_test').length;
  const total = hypotheses.length;
  const maxE = total > 0 ? Math.max(...hypotheses.map((h) => h.e)) : 0;

  const v2Hypotheses = labV2Data?.hypotheses ?? [];
  const v2UnderTest = v2Hypotheses.filter((h) => h.status === 'under_test').length;
  const v2Total = v2Hypotheses.length;
  const v2MaxE = v2Total > 0 ? Math.max(...v2Hypotheses.map((h) => h.e)) : 0;

  const nextMs = nextLabBarAt(now);
  const nextDate = new Date(nextMs);
  const utcHours = String(nextDate.getUTCHours()).padStart(2, '0');
  const utcMinutes = String(nextDate.getUTCMinutes()).padStart(2, '0');
  const utcTimeStr = `${utcHours}:${utcMinutes}`;
  const localTimeStr = nextDate.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  const diffMs = Math.max(0, nextMs - now);
  const totalMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(totalMinutes / 60);
  const diffMinutes = totalMinutes % 60;

  return (
    <section aria-labelledby={id} className="rounded-lg border border-border p-4">
      <h2 id={id} className="text-sm font-semibold">
        When to look
      </h2>

      <p
        data-testid="look-headline"
        className={
          reasons.length > 0
            ? 'text-sm font-medium text-accent'
            : 'text-sm text-muted-foreground'
        }
      >
        {reasons.length > 0
          ? `Worth a look: ${reasons.join('; ')}`
          : 'Nothing needs a look right now.'}
      </p>
      <p className="sr-only" aria-live="polite">
        {reasons.length > 0 ? 'Worth a look.' : 'Nothing needs a look right now.'}
      </p>

      <dl className="mt-3 grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-2 text-xs">
        <dt className="text-muted-foreground">Prices</dt>
        <dd>
          <span>{statusSentence(status, lastMessageAt)}</span>
          {lastMessageAt !== null && Number.isFinite(lastMessageAt) && (
            <>
              {' '}
              Data age{' '}
              <span className="font-mono tabular-nums" suppressHydrationWarning>
                {Math.max(0, Math.round((now - lastMessageAt) / 1000))}
              </span>{' '}
              s.
            </>
          )}
          {status !== 'live' && (
            <Button
              variant="outline"
              size="sm"
              className="ml-2 h-7"
              onClick={retry}
              aria-label="Reconnect live prices"
            >
              Retry
            </Button>
          )}
        </dd>

        <dt className="text-muted-foreground">Bar arrival</dt>
        <dd>
          {arrival ? (
            <>
              Last 1-minute BTC bar arrived{' '}
              <span className="font-mono tabular-nums">
                {(arrival.lagMs / 1000).toFixed(1)}
              </span>{' '}
              s after it closed, at{' '}
              <span className="font-mono tabular-nums">
                {new Date(arrival.receivedAt).toISOString().slice(11, 19)}
              </span>{' '}
              UTC (measured on this device&apos;s clock).
            </>
          ) : (
            'Waiting for the next closed 1-minute bar.'
          )}
        </dd>

        <dt className="text-muted-foreground">Levels</dt>
        <dd>
          {watchlistLoading ? (
            'Loading the watchlist.'
          ) : symbols.length === 0 ? (
            "Add coins to the watchlist to see their distance to yesterday's levels."
          ) : levelsLoading ? (
            "Loading yesterday's levels."
          ) : levelsError || !levelsData ? (
            "Could not load yesterday's levels."
          ) : nearCoins.length === 0 ? (
            <>
              No watchlist coin is within{' '}
              <span className="font-mono tabular-nums">0.5</span> daily ATR of
              yesterday&apos;s high, low or close.
            </>
          ) : (
            <>
              Near a prior-day level (within{' '}
              <span className="font-mono tabular-nums">0.5</span> daily ATR):{' '}
              {nearCoins.map((coin, index) => {
                const base = coin.symbol.replace(/USDT$/, '');
                const abs = Math.abs(coin.distanceAtr).toFixed(1);
                const dir = coin.distanceAtr < 0 ? 'below' : 'above';
                const lvl = `prev ${coin.level}`;
                return (
                  <span key={coin.symbol}>
                    {index > 0 && ', '}
                    {base} is{' '}
                    <span className="font-mono tabular-nums">{abs}</span> ATR{' '}
                    {dir} the {lvl}
                  </span>
                );
              })}
              .
            </>
          )}
        </dd>

        <dt className="text-muted-foreground">Signals</dt>
        <dd>
          <span>No rule is validated, so nothing here says when to trade. </span>
          <span>v8 combined score ({V8_STATUS.label}). </span>
          {rvSentence && <span>{rvSentence} </span>}
          {labLoading ? (
            <span>Loading the forward lab.</span>
          ) : labError || !labData ? (
            <>
              <span>Could not load the forward lab.</span>
              <Button
                variant="outline"
                size="sm"
                className="ml-2 h-7"
                onClick={() => refetchLab()}
                aria-label="Retry forward lab"
              >
                Retry
              </Button>
            </>
          ) : labData.hypotheses.length === 0 ? (
            <span>The forward lab has not graded a bar yet.</span>
          ) : (
            <span>
              Forward lab {labData.version}:{' '}
              <span className="font-mono tabular-nums">{underTest}</span> of{' '}
              <span className="font-mono tabular-nums">{total}</span> hypotheses
              under test; strongest evidence e ={' '}
              <span className="font-mono tabular-nums">{maxE.toFixed(2)}</span>{' '}
              of <span className="font-mono tabular-nums">{labData.threshold}</span>{' '}
              needed.
            </span>
          )}
          {' '}
          {labV2Loading ? (
            <span>Loading the forward lab lab-v2.</span>
          ) : labV2Error || !labV2Data ? (
            <>
              <span>Could not load the forward lab lab-v2.</span>
              <Button
                variant="outline"
                size="sm"
                className="ml-2 h-7"
                onClick={() => refetchLabV2()}
                aria-label="Retry lab-v2"
              >
                Retry
              </Button>
            </>
          ) : labV2Data.hypotheses.length === 0 ? (
            <span>Forward lab lab-v2 has not graded a bar yet.</span>
          ) : (
            <span>
              {`Forward lab lab-v2: ${v2UnderTest} of ${v2Total} hypotheses under test; strongest evidence e = ${v2MaxE.toFixed(2)} of ${labV2Data.threshold} needed.`}
            </span>
          )}
        </dd>

        <dt className="text-muted-foreground">Next update</dt>
        <dd>
          Next 8-hour lab bar at{' '}
          <span className="font-mono tabular-nums">{utcTimeStr}</span> UTC
          {isClient && (
            <>
              {' '}(
              <span className="font-mono tabular-nums">
                {localTimeStr}
              </span>{' '}
              your time)
            </>
          )}
          , in{' '}
          <span className="font-mono tabular-nums" suppressHydrationWarning>{diffHours}</span> h{' '}
          <span className="font-mono tabular-nums" suppressHydrationWarning>{diffMinutes}</span> min.{' '}
          Faster lab timeframes update as their bars close; grading runs hourly
          at <span className="font-mono tabular-nums">:20</span> UTC.
        </dd>
      </dl>
    </section>
  );
}
