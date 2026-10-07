'use client';

import { useEffect, useMemo, useState } from 'react';

import { useCostCheckMarket, useCostCheckSymbols } from '@/hooks/useCostCheck';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  STORAGE_KEY,
  applyUrlParams,
  computeCostCheck,
  notionalOf,
  parseStoredInputs,
  type CostCheckInputs,
} from '@/lib/costs/cost-check-model';
import { CostCheckForm } from './CostCheckForm';
import { CostCheckResult } from './CostCheckResult';
import { CostCheckSummaryBar } from './CostCheckSummaryBar';

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

function marketProblemText(code: string | undefined): string {
  switch (code) {
    case 'venue_unreachable':
      return 'the exchange could not be reached';
    case 'venue_rate_limited':
      return 'the exchange is rate limiting requests';
    case 'unknown_symbol':
      return 'this perpetual is not trading';
    case 'rate_limited':
      return 'too many checks in a minute, try again shortly';
    default:
      return 'the request failed';
  }
}

export function CostCheckView() {
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
  // A previous symbol's data stays visible while the next one loads; never price a trade with it.
  const marketData = market.data && market.data.symbol === inputs.symbol ? market.data : null;

  const model = useMemo(() => computeCostCheck(inputs, marketData, now), [inputs, marketData, now]);

  const marketProblem =
    market.isError && !marketData ? marketProblemText(market.error?.code) : null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <CostCheckForm
          inputs={inputs}
          onChange={(patch) => setInputs((prev) => ({ ...prev, ...patch }))}
          symbols={symbols.data?.symbols}
          symbolsLoading={symbols.isLoading}
          symbolsError={symbols.isError}
          measuredSlippageBps={
            marketData?.slippage.source === 'depth' ? marketData.slippage.bps : null
          }
        />
        <CostCheckResult
          inputs={inputs}
          model={model}
          market={marketData}
          marketProblem={marketProblem}
          isFetching={market.isFetching}
          isLoading={!marketData && !market.isError}
        />
      </div>
      <CostCheckSummaryBar model={model} />
    </div>
  );
}
