'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useCostCheckMarket, useCostCheckRegime, useCostCheckSymbols } from '@/hooks/useCostCheck';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  STORAGE_KEY,
  applyUrlParams,
  computeCostCheck,
  notionalOf,
  parseStoredInputs,
  type CostCheckInputs,
  type CostCheckModel,
} from '@/lib/costs/cost-check-model';
import { marketProblemText } from '@/lib/costs/market-problem';
import { pickMeasurementInterval } from '@/lib/costs/move';
import type {
  CostCheckMarketResponse,
  CostCheckRegimeResponse,
  CostCheckSymbolsResponse,
} from '@/types/cost-check';

export interface CostCheckState {
  inputs: CostCheckInputs;
  updateInputs: (patch: Partial<CostCheckInputs>) => void;
  model: CostCheckModel;
  marketData: CostCheckMarketResponse | null;
  marketProblem: string | null;
  marketLoading: boolean;
  marketFetching: boolean;
  retryMarket: () => void;
  measuredSlippageBps: number | null;
  symbols: { list: CostCheckSymbolsResponse['symbols'] | undefined; isLoading: boolean; isError: boolean };
  regime: { data: CostCheckRegimeResponse['regime'] | undefined; isLoading: boolean; problem: string | null; retry: () => void };
}

/** Saved inputs, then URL parameters on top. Runs in the browser only (the page loads this view without SSR). */
function initialInputs(): CostCheckInputs {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private mode, disabled site data): start from the defaults.
  }
  return applyUrlParams(parseStoredInputs(raw), new URLSearchParams(window.location.search));
}

export function useCostCheckState(): CostCheckState {
  const [inputs, setInputs] = useState<CostCheckInputs>(initialInputs);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(inputs));
    } catch {
      // Not saved; the page still works.
    }
  }, [inputs]);

  // Funding settlements are counted from "now"; keep it fresh without re-rendering every second.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Size and hold drive server requests (order book depth, kline interval); wait for typing to settle.
  const notional = useDebouncedValue(notionalOf(inputs), 500);
  const holdMinutes = useDebouncedValue(inputs.holdMinutes, 400);

  const symbols = useCostCheckSymbols();
  const market = useCostCheckMarket(inputs.symbol, holdMinutes, notional);
  const regime = useCostCheckRegime();

  // The query keeps the previous response while the next one loads. Never price a trade with a move
  // measured for another symbol or hold; a depth measured for another size is used but labelled.
  const expected = pickMeasurementInterval(inputs.holdMinutes * 60_000);
  const data = market.data;
  const marketData =
    data &&
    data.symbol === inputs.symbol &&
    data.measurement.interval === expected.interval &&
    data.measurement.holdBars === expected.holdBars
      ? data
      : null;
  const slippageForOtherSize =
    marketData !== null && (market.isPlaceholderData || notional !== notionalOf(inputs));

  const model = useMemo(
    () => computeCostCheck(inputs, marketData, now, { slippageForOtherSize }),
    [inputs, marketData, now, slippageForOtherSize]
  );

  const marketProblem =
    market.isError && !marketData ? marketProblemText(market.error?.code) : null;

  const updateInputs = useCallback((patch: Partial<CostCheckInputs>) => {
    setInputs((prev) => ({ ...prev, ...patch }));
  }, []);

  return {
    inputs,
    updateInputs,
    model,
    marketData,
    marketProblem,
    marketLoading: !marketData && !market.isError,
    marketFetching: market.isFetching,
    retryMarket: () => {
      void market.refetch();
    },
    measuredSlippageBps:
      marketData?.slippage.source === 'depth' ? marketData.slippage.bps : null,
    symbols: {
      list: symbols.data?.symbols,
      isLoading: symbols.isLoading,
      isError: symbols.isError,
    },
    regime: {
      data: regime.data?.regime,
      isLoading: regime.isLoading,
      problem: regime.isError ? marketProblemText(regime.error?.code) : null,
      retry: () => {
        void regime.refetch();
      },
    },
  };
}
