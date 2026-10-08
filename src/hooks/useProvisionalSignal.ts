'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useGlobalSignals, type GlobalSignalRecord } from '@/hooks/useSignals';
import { fetchJson } from '@/lib/fetch-json';
import type { TradingStyle } from '@/lib/models/signal-template';
import { scoreProvisional } from '@/lib/signals/provisional/score-provisional';
import { isProvisionalEligible, STYLE_CADENCE_MS } from '@/lib/signals/provisional/styles';
import type {
  FormingBar,
  ProvisionalContext,
  ProvisionalContextReady,
  ProvisionalScore,
} from '@/lib/signals/provisional/types';
import { useFormingBarStore, type FormingBarEvent } from '@/stores/formingBarStore';
import type { SignalTier } from '@/types/signal';

export type ProvisionalStatus =
  | 'unavailable'
  | 'loading'
  | 'waiting'
  | 'provisional'
  | 'awaiting-record'
  | 'recorded'
  | 'no-record';

export interface RecordedSignal {
  score: number;
  tier: SignalTier;
  confidence: number;
  configVersion: number;
}

export interface ProvisionalSignalState {
  status: ProvisionalStatus;
  reason: string | null;
  /** The forming bar's value, or the closed bar's final one while awaiting its record. */
  provisional: ProvisionalScore | null;
  /** The scheduler's recorded values by candleTimestamp. */
  recorded: ReadonlyMap<number, RecordedSignal>;
  configVersion: number | null;
  /** Duration of the last scoreProvisional call. */
  lastComputeMs: number | null;
}

/** Minimum gap between two computes. */
const COMPUTE_FLOOR_MS = 2_000;
const CONTEXT_REFETCH_MS = 5 * 60_000;
const CONTEXT_RETRY_MS = 30_000;
const RECORD_POLL_MS = 10_000;
const RECORD_GRACE_MS = 5 * 60_000;
/** Minimum gap between context refetches requested by a newer bar. */
const CONTEXT_REQUEST_GAP_MS = 5_000;
const HISTORY_LIMIT = 200;

/**
 * The provisional score is held in component state only. It never goes into
 * React Query, a Zustand store, Web Storage or a request: the three requests
 * this hook makes are GETs that carry no score.
 */
interface Live {
  key: string;
  status: 'provisional' | 'awaiting-record' | 'recorded' | 'no-record' | null;
  provisional: ProvisionalScore | null;
  lastComputeMs: number | null;
  /** Bar the awaiting-record status refers to. */
  awaitingOpenTime: number | null;
  /** Records the poll found before the history query caught up. */
  extra: ReadonlyMap<number, RecordedSignal>;
}

const EMPTY_RECORDED: ReadonlyMap<number, RecordedSignal> = new Map();

function initialLive(key: string): Live {
  return {
    key,
    status: null,
    provisional: null,
    lastComputeMs: null,
    awaitingOpenTime: null,
    extra: EMPTY_RECORDED,
  };
}

function sameBar(a: FormingBar, b: FormingBar): boolean {
  return (
    a.openTime === b.openTime &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume &&
    a.takerBuyVolume === b.takerBuyVolume
  );
}

function toRecorded(s: GlobalSignalRecord): RecordedSignal {
  return { score: s.score, tier: s.tier, confidence: s.confidence, configVersion: s.configVersion };
}

interface EngineDeps {
  key: string;
  symbol: string;
  interval: string;
  style: TradingStyle;
  setLive: (fn: (prev: Live) => Live) => void;
  refetchContext: () => void;
  onRecord: () => void;
}

interface Engine {
  setContext: (ctx: ProvisionalContext | undefined) => void;
  dispose: () => void;
}

function createEngine(deps: EngineDeps): Engine {
  const { key, symbol, interval, style, setLive, refetchContext, onRecord } = deps;
  let ctx: ProvisionalContext | undefined;
  let lastBar: FormingBar | null = null;
  let lastComputeAt = Number.NEGATIVE_INFINITY;
  let pendingBar: FormingBar | null = null;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  let closedOpenTime: number | null = null;
  let lastContextRequestAt = Number.NEGATIVE_INFINITY;
  const awaiting = new Map<number, { poll: ReturnType<typeof setInterval>; deadline: ReturnType<typeof setTimeout> }>();

  const patch = (changes: Partial<Live>) =>
    setLive((prev) => ({ ...(prev.key === key ? prev : initialLive(key)), ...changes }));

  const compute = (ready: ProvisionalContextReady, bar: FormingBar): ProvisionalScore | null => {
    const started = performance.now();
    const score = scoreProvisional(ready, bar);
    const lastComputeMs = performance.now() - started;
    lastComputeAt = Date.now();
    lastBar = bar;
    if (score) patch({ provisional: score, lastComputeMs, status: 'provisional', awaitingOpenTime: null });
    return score;
  };

  const clearTrailing = () => {
    if (trailing) clearTimeout(trailing);
    trailing = null;
    pendingBar = null;
  };

  const settle = (openTime: number, outcome: 'recorded' | 'no-record', record?: RecordedSignal) => {
    const entry = awaiting.get(openTime);
    if (entry) {
      clearInterval(entry.poll);
      clearTimeout(entry.deadline);
      awaiting.delete(openTime);
    }
    setLive((prev) => {
      const base = prev.key === key ? prev : initialLive(key);
      const extra = record ? new Map(base.extra).set(openTime, record) : base.extra;
      const showing = base.status === 'awaiting-record' && base.awaitingOpenTime === openTime;
      return showing
        ? { ...base, extra, status: outcome, provisional: null, awaitingOpenTime: null }
        : { ...base, extra };
    });
    if (record) onRecord();
  };

  const startAwaiting = (openTime: number) => {
    if (awaiting.has(openTime)) return;
    const poll = setInterval(async () => {
      try {
        const params = new URLSearchParams({ symbol, tradingStyle: style, interval });
        const { signal } = await fetchJson<{ signal: GlobalSignalRecord | null }>(
          `/api/signals/latest?${params}`
        );
        if (signal && signal.candleTimestamp === openTime && awaiting.has(openTime)) {
          settle(openTime, 'recorded', toRecorded(signal));
        }
      } catch {
        // keep polling until the deadline
      }
    }, RECORD_POLL_MS);
    const deadline = setTimeout(
      () => settle(openTime, 'no-record'),
      STYLE_CADENCE_MS[style] + RECORD_GRACE_MS
    );
    awaiting.set(openTime, { poll, deadline });
  };

  const requestContext = () => {
    const now = Date.now();
    if (now - lastContextRequestAt < CONTEXT_REQUEST_GAP_MS) return;
    lastContextRequestAt = now;
    refetchContext();
  };

  const handleTick = (event: FormingBarEvent) => {
    if (event.symbol !== symbol || event.interval !== interval || !ctx) return;
    const { bar } = event;

    if (bar.openTime > ctx.formingOpenTime) {
      clearTrailing();
      requestContext();
      return;
    }
    if (bar.openTime < ctx.formingOpenTime || !ctx.ready) return;
    if (bar.openTime === closedOpenTime) return;

    if (event.closed) {
      clearTrailing();
      closedOpenTime = bar.openTime;
      const score = compute(ctx, bar);
      patch({ status: 'awaiting-record', awaitingOpenTime: bar.openTime, ...(score ? {} : { provisional: null }) });
      startAwaiting(bar.openTime);
      return;
    }

    if (lastBar && sameBar(lastBar, bar)) {
      return;
    }
    const wait = lastComputeAt + COMPUTE_FLOOR_MS - Date.now();
    if (wait <= 0) {
      clearTrailing();
      compute(ctx, bar);
      return;
    }
    pendingBar = bar;
    if (!trailing) {
      trailing = setTimeout(() => {
        trailing = null;
        const next = pendingBar;
        pendingBar = null;
        if (next && ctx?.ready && next.openTime === ctx.formingOpenTime && !(lastBar && sameBar(lastBar, next))) {
          compute(ctx, next);
        }
      }, wait);
    }
  };

  const unsubscribe = useFormingBarStore.subscribe((state, prev) => {
    if (state.latest && state.latest !== prev.latest) handleTick(state.latest);
  });

  return {
    setContext(next) {
      ctx = next;
      lastBar = null;
      if (!next?.ready) return;
      const latest = useFormingBarStore.getState().latest;
      if (latest && !latest.closed) handleTick(latest);
    },
    dispose() {
      unsubscribe();
      clearTrailing();
      for (const entry of awaiting.values()) {
        clearInterval(entry.poll);
        clearTimeout(entry.deadline);
      }
      awaiting.clear();
    },
  };
}

export function useProvisionalSignal(
  symbol: string,
  interval: string,
  style: TradingStyle | null
): ProvisionalSignalState {
  const eligible = isProvisionalEligible(symbol, interval, style);
  const activeStyle = eligible ? style : null;
  const key = `${symbol}|${interval}|${style ?? ''}`;
  const queryClient = useQueryClient();

  const contextQuery = useQuery<ProvisionalContext>({
    queryKey: ['provisionalContext', symbol, interval, style],
    queryFn: () => {
      const params = new URLSearchParams({ symbol, interval, style: style ?? '' });
      return fetchJson(`/api/signals/provisional-context?${params}`);
    },
    enabled: eligible,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.ready === true ? CONTEXT_REFETCH_MS : CONTEXT_RETRY_MS,
  });
  const history = useGlobalSignals(eligible ? symbol : null, activeStyle, interval, HISTORY_LIMIT);

  const [live, setLive] = useState<Live>(() => initialLive(key));
  const refetchRef = useRef(contextQuery.refetch);
  const engineRef = useRef<Engine | null>(null);

  useEffect(() => {
    refetchRef.current = contextQuery.refetch;
  }, [contextQuery.refetch]);

  useEffect(() => {
    if (!eligible || !style) return;
    const engine = createEngine({
      key,
      symbol,
      interval,
      style,
      setLive,
      refetchContext: () => {
        void refetchRef.current({ cancelRefetch: false });
      },
      onRecord: () => {
        void queryClient.invalidateQueries({
          queryKey: ['globalSignals', symbol, style, interval, HISTORY_LIMIT],
        });
      },
    });
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [eligible, key, symbol, interval, style, queryClient]);

  const context = contextQuery.data;
  useEffect(() => {
    engineRef.current?.setContext(context);
  }, [context, key, eligible]);

  const current = live.key === key ? live : initialLive(key);

  const recorded = useMemo(() => {
    const map = new Map<number, RecordedSignal>();
    for (const s of history.data?.signals ?? []) map.set(s.candleTimestamp, toRecorded(s));
    for (const [t, r] of current.extra) map.set(t, r);
    return map;
  }, [history.data, current.extra]);

  const configVersion = eligible ? (context?.configVersion ?? null) : null;
  const base = { recorded, configVersion, lastComputeMs: current.lastComputeMs };

  if (!eligible) {
    return {
      ...base,
      recorded: EMPTY_RECORDED,
      lastComputeMs: null,
      status: 'unavailable',
      reason: 'No provisional score for this symbol, interval or style',
      provisional: null,
    };
  }
  if (!context) {
    return contextQuery.isError
      ? { ...base, status: 'waiting', reason: 'Signal context could not be loaded', provisional: null }
      : { ...base, status: 'loading', reason: null, provisional: null };
  }
  if (!context.ready) {
    return { ...base, status: 'waiting', reason: context.reason, provisional: null };
  }
  if (current.status === null) {
    return { ...base, status: 'waiting', reason: 'Waiting for the next price update', provisional: null };
  }
  return {
    ...base,
    status: current.status,
    reason: current.status === 'no-record' ? 'The scheduler recorded no value for this bar in time' : null,
    provisional: current.provisional,
  };
}
