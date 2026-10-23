import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CostResults } from './CostResults';
import {
  DEFAULT_INPUTS,
  computeCostCheck,
} from '@/lib/costs/cost-check-model';
import type { CostCheckMarketResponse } from '@/types/cost-check';

const NOW = Date.UTC(2026, 9, 7, 9, 30);

function createMarketFixture(
  overrides: Partial<CostCheckMarketResponse> = {}
): CostCheckMarketResponse {
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

describe('CostResults', () => {
  it('renders fixture model numbers, 56px focal cost and verdict label', () => {
    const market = createMarketFixture();
    const model = computeCostCheck(DEFAULT_INPUTS, market, NOW);
    const { container } = render(
      <CostResults
        model={model}
        marketData={market}
        marketProblem={null}
        marketLoading={false}
        marketFetching={false}
        retryMarket={vi.fn()}
      />
    );

    const focal = screen.getByTestId('focal-round-trip-cost');
    expect(focal).toHaveTextContent('$1.20');
    expect(focal).toHaveClass('text-[56px]');

    expect(screen.getByText('(0.12%)')).toBeInTheDocument();
    expect(screen.getByTestId('cost-verdict-label')).toHaveTextContent('Costs dominate');
    expect(screen.getByText('0.12%')).toBeInTheDocument();
    expect(screen.getByText(/65\.0% win rate needed/)).toBeInTheDocument();
    expect(screen.getByText('0.2 bps')).toBeInTheDocument();

    expect(container.textContent).not.toMatch(/\bbuy\b|\bsell\b|safe|recommend/i);
  });

  it('renders loading state when marketLoading is true', () => {
    const market = createMarketFixture();
    const model = computeCostCheck(DEFAULT_INPUTS, market, NOW);
    render(
      <CostResults
        model={model}
        marketData={null}
        marketProblem={null}
        marketLoading={true}
        marketFetching={false}
        retryMarket={vi.fn()}
      />
    );

    expect(screen.getByText('Loading market data.')).toBeInTheDocument();
  });

  it('renders market error notice, Try again calls retryMarket, and round-trip number still renders', async () => {
    const user = userEvent.setup();
    const retryMarket = vi.fn();
    const model = computeCostCheck(DEFAULT_INPUTS, null, NOW);

    render(
      <CostResults
        model={model}
        marketData={null}
        marketProblem="the exchange could not be reached"
        marketLoading={false}
        marketFetching={false}
        retryMarket={retryMarket}
      />
    );

    expect(
      screen.getByText(
        `Live market data did not load: the exchange could not be reached. Slippage uses a flat ${model.slippageBps} bps assumption and funding is not included.`
      )
    ).toBeInTheDocument();

    const tryAgainBtn = screen.getByRole('button', { name: 'Try again' });
    await user.click(tryAgainBtn);
    expect(retryMarket).toHaveBeenCalledTimes(1);

    const focal = screen.getByTestId('focal-round-trip-cost');
    expect(focal).toHaveTextContent(`$${model.verdictCostUsdt.toFixed(2)}`);
  });

  it('renders verdictCostUsdt as focal number when funding is received, and displays "You receive"', () => {
    const market = createMarketFixture({
      funding: { rate: -0.0005, intervalHours: 8, nextFundingTime: NOW + 1_800_000 },
    });
    const model = computeCostCheck(DEFAULT_INPUTS, market, NOW);

    expect(model.roundTrip.fundingUsdt).toBeLessThan(0);
    expect(model.roundTrip.totalUsdt).not.toBe(model.verdictCostUsdt);

    render(
      <CostResults
        model={model}
        marketData={market}
        marketProblem={null}
        marketLoading={false}
        marketFetching={false}
        retryMarket={vi.fn()}
      />
    );

    const focal = screen.getByTestId('focal-round-trip-cost');
    expect(focal).toHaveTextContent(`$${model.verdictCostUsdt.toFixed(2)}`);
    expect(screen.getByText(/You receive/)).toBeInTheDocument();
  });

  it('displays "n/a" in funding row when market is null', () => {
    const model = computeCostCheck(DEFAULT_INPUTS, null, NOW);

    render(
      <CostResults
        model={model}
        marketData={null}
        marketProblem={null}
        marketLoading={false}
        marketFetching={false}
        retryMarket={vi.fn()}
      />
    );

    expect(screen.getByText('Funding over hold')).toBeInTheDocument();
    expect(screen.getAllByText('n/a').length).toBeGreaterThan(0);
  });

  it('renders tone label without text-up or text-down classes', () => {
    const marketSmall = createMarketFixture({
      move: { medianPercent: 8, meanPercent: 10, p75Percent: 12, samples: 995, independentWindows: 249 },
    });
    const modelSmall = computeCostCheck(DEFAULT_INPUTS, marketSmall, NOW);

    const { rerender } = render(
      <CostResults
        model={modelSmall}
        marketData={marketSmall}
        marketProblem={null}
        marketLoading={false}
        marketFetching={false}
        retryMarket={vi.fn()}
      />
    );

    const labelSmall = screen.getByTestId('cost-verdict-label');
    expect(labelSmall).toHaveClass('text-foreground', 'font-semibold');
    expect(labelSmall).not.toHaveClass('text-up');
    expect(labelSmall).not.toHaveClass('text-down');

    const marketDominate = createMarketFixture();
    const modelDominate = computeCostCheck(DEFAULT_INPUTS, marketDominate, NOW);
    rerender(
      <CostResults
        model={modelDominate}
        marketData={marketDominate}
        marketProblem={null}
        marketLoading={false}
        marketFetching={false}
        retryMarket={vi.fn()}
      />
    );

    const labelDominate = screen.getByTestId('cost-verdict-label');
    expect(labelDominate).toHaveClass('text-foreground', 'font-semibold');
    expect(labelDominate).not.toHaveClass('text-up');
    expect(labelDominate).not.toHaveClass('text-down');
  });

  it('hides the numbers and shows the fix message when inputsValid is false', () => {
    const market = createMarketFixture();
    const model = computeCostCheck(DEFAULT_INPUTS, market, NOW);

    render(
      <CostResults
        model={model}
        marketData={market}
        marketProblem={null}
        marketLoading={false}
        marketFetching={false}
        retryMarket={vi.fn()}
        inputsValid={false}
      />
    );

    expect(screen.getByText('Fix the highlighted inputs to see the costs.')).toBeInTheDocument();
    expect(screen.queryByTestId('focal-round-trip-cost')).not.toBeInTheDocument();
  });

  it('renders the insufficient-data state when independentWindows < 100', () => {
    const market = createMarketFixture({
      move: {
        medianPercent: 0.3,
        meanPercent: 0.4,
        p75Percent: 0.5,
        samples: 200,
        independentWindows: 50,
      },
    });
    const model = computeCostCheck(DEFAULT_INPUTS, market, NOW);

    render(
      <CostResults
        model={model}
        marketData={market}
        marketProblem={null}
        marketLoading={false}
        marketFetching={false}
        retryMarket={vi.fn()}
      />
    );

    expect(
      screen.getByText(/Insufficient data for a verdict: 50 of 100 independent windows/)
    ).toBeInTheDocument();
  });

  it('renders slippage label when slippageForOtherSize is true', () => {
    const market = createMarketFixture();
    const model = computeCostCheck(DEFAULT_INPUTS, market, NOW, {
      slippageForOtherSize: true,
    });

    render(
      <CostResults
        model={model}
        marketData={market}
        marketProblem={null}
        marketLoading={false}
        marketFetching={false}
        retryMarket={vi.fn()}
      />
    );

    expect(screen.getAllByText('Measured for previous size').length).toBeGreaterThan(0);
  });
});
