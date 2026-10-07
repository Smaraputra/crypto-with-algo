import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DEFAULT_INPUTS, computeCostCheck } from '@/lib/costs/cost-check-model';
import type { CostCheckMarketResponse } from '@/types/cost-check';
import { CostCheckResult } from './CostCheckResult';

const NOW = Date.UTC(2026, 9, 7, 9, 30);

function market(overrides: Partial<CostCheckMarketResponse> = {}): CostCheckMarketResponse {
  return {
    symbol: 'BTCUSDT',
    asOf: NOW,
    stale: false,
    markPrice: 60_000,
    funding: { rate: 0.0001, intervalHours: 8, nextFundingTime: Date.UTC(2026, 9, 7, 16) },
    venue: { minNotional: 50, minQty: 0.001, stepSize: 0.001, tickSize: 0.1, effectiveMinNotional: 60 },
    measurement: { interval: '15m', holdBars: 4, measuredHoldMs: 3_600_000, barsUsed: 999 },
    move: { medianPercent: 0.3, meanPercent: 0.4, p75Percent: 0.55, samples: 995, independentWindows: 249 },
    slippage: { bps: 1, source: 'depth', halfSpreadBps: 0.1, exceedsTopOfBook: false },
    onboardDate: 0,
    ...overrides,
  };
}

function renderWith(m: CostCheckMarketResponse | null, inputs = DEFAULT_INPUTS, marketProblem: string | null = null) {
  const model = computeCostCheck(inputs, m, NOW);
  render(<CostCheckResult inputs={inputs} model={model} market={m} marketProblem={marketProblem} isFetching={false} />);
}

describe('CostCheckResult', () => {
  it('leads with the tone and the breakeven win rate, in words', () => {
    renderWith(market());
    const verdict = screen.getByTestId('cost-check-verdict');
    expect(verdict).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('cost-check-tone')).toHaveTextContent('Costs dominate');
    expect(screen.getByTestId('cost-check-tone')).toHaveClass('text-bearish');
    expect(verdict).toHaveTextContent(
      'If wins and losses are each about the typical 0.40% move of a 1h hold, you must call direction right more than 65.0% of the time just to cover 0.120% of costs.'
    );
  });

  it('breaks the round trip down in percent and USDT', () => {
    renderWith(market());
    const table = screen.getByTestId('cost-check-breakdown');
    expect(table).toHaveTextContent('Fees0.1000%1.00');
    expect(table).toHaveTextContent('1.00 bps per market order, measured from the order book for this size');
    expect(table).toHaveTextContent('no settlement in the hold (every 8h)');
    expect(table).toHaveTextContent('Total0.1200%1.20');
  });

  it('says when costs exceed the typical move', () => {
    renderWith(market({ move: { medianPercent: 0.05, meanPercent: 0.08, p75Percent: 0.1, samples: 995, independentWindows: 249 } }));
    expect(screen.getByTestId('cost-check-tone')).toHaveTextContent('Costs exceed the typical move');
    expect(screen.getByTestId('cost-check-verdict')).toHaveTextContent('no win rate breaks even');
  });

  it('never colours a small cost green', () => {
    renderWith(market(), { ...DEFAULT_INPUTS, holdMinutes: 10_080 });
    const m = market({ move: { medianPercent: 8, meanPercent: 10, p75Percent: 12, samples: 995, independentWindows: 142 } });
    renderWith(m, { ...DEFAULT_INPUTS, holdMinutes: 10_080 });
    const tones = screen.getAllByTestId('cost-check-tone');
    const small = tones.find((t) => t.textContent === 'Costs small');
    expect(small).toBeDefined();
    expect(small!.className).not.toMatch(/bullish|green/);
  });

  it('withholds the verdict on thin history', () => {
    renderWith(market({ move: { medianPercent: 0.3, meanPercent: 0.4, p75Percent: 0.5, samples: 200, independentWindows: 50 } }));
    expect(screen.getByTestId('cost-check-verdict')).toHaveTextContent('Too little history for a verdict');
    expect(screen.queryByTestId('cost-check-tone')).not.toBeInTheDocument();
  });

  it('still prices the trade without market data, and says why there is no verdict', () => {
    renderWith(null, DEFAULT_INPUTS, 'the exchange could not be reached');
    expect(screen.getByTestId('cost-check-verdict')).toHaveTextContent(
      'Market data is unavailable: the exchange could not be reached.'
    );
    expect(screen.getByTestId('cost-check-breakdown')).toHaveTextContent('flat assumption, no order book');
  });

  it('warns on stale data and on an order below the venue minimum', () => {
    renderWith(market({ stale: true }), { ...DEFAULT_INPUTS, margin: 5, leverage: 10 });
    expect(screen.getByText(/could not be reached. Market data is from 2026-10-07 09:30 UTC/)).toBeInTheDocument();
    expect(screen.getByText(/must be at least/)).toHaveTextContent('must be at least 60.00 USDT');
  });

  it('shows funding received without crediting it to the verdict', () => {
    renderWith(market(), { ...DEFAULT_INPUTS, side: 'short', holdMinutes: 1440 });
    expect(screen.getByText('Funding received')).toBeInTheDocument();
    expect(screen.getByText(/not credited in the verdict/)).toBeInTheDocument();
  });
});
