import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CostCheckScreen } from './CostCheckScreen';
import {
  DEFAULT_INPUTS,
  computeCostCheck,
  MAX_HOLD_MINUTES,
  MAX_LEVERAGE,
} from '@/lib/costs/cost-check-model';
import type { CostCheckMarketResponse } from '@/types/cost-check';
import type { CostCheckState } from '@/hooks/useCostCheckState';

const mockUseCostCheckState = vi.fn();

vi.mock('@/hooks/useCostCheckState', () => ({
  useCostCheckState: () => mockUseCostCheckState(),
}));

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

function createCostCheckStateFixture(
  overrides: Partial<CostCheckState> = {}
): CostCheckState {
  const marketData = createMarketFixture();
  const inputs = DEFAULT_INPUTS;
  const model = computeCostCheck(inputs, marketData, NOW);

  return {
    inputs,
    updateInputs: vi.fn(),
    model,
    marketData,
    marketProblem: null,
    marketLoading: false,
    marketFetching: false,
    retryMarket: vi.fn(),
    measuredSlippageBps: 1,
    symbols: {
      list: [
        { symbol: 'BTCUSDT', baseAsset: 'BTC', onboardDate: 1568000000000 },
        { symbol: 'ETHUSDT', baseAsset: 'ETH', onboardDate: 1570000000000 },
      ],
      isLoading: false,
      isError: false,
    },
    regime: {
      data: {
        symbol: 'BTCUSDT',
        day: Date.UTC(2026, 9, 6),
        dayVolPercent: 2.1,
        thresholdVolPercent: 2.5,
        percentile: 65,
        high: false,
        trailingDays: 180,
      },
      isLoading: false,
      problem: null,
      retry: vi.fn(),
    },
    ...overrides,
  };
}

describe('CostCheckScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders PageHeader and displays fixture model numbers in results', () => {
    const fixture = createCostCheckStateFixture();
    mockUseCostCheckState.mockReturnValue(fixture);

    const { container } = render(<CostCheckScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'Cost Check' })).toBeInTheDocument();
    expect(
      screen.getByText('What a round trip costs on your own position, before you place it.')
    ).toBeInTheDocument();

    const focal = screen.getByTestId('focal-round-trip-cost');
    expect(focal).toHaveTextContent('$1.20');
    expect(screen.getByTestId('cost-verdict-label')).toHaveTextContent('Costs dominate');

    expect(container.textContent).not.toMatch(/\bbuy\b|\bsell\b|safe|recommend/i);
  });

  it('renders the phone sticky summary with verdictCostUsdt and move needed', () => {
    const market = createMarketFixture({
      funding: { rate: -0.0005, intervalHours: 8, nextFundingTime: NOW + 1_800_000 },
    });
    const model = computeCostCheck(DEFAULT_INPUTS, market, NOW);
    expect(model.roundTrip.totalUsdt).not.toBe(model.verdictCostUsdt);

    const fixture = createCostCheckStateFixture({ marketData: market, model });
    mockUseCostCheckState.mockReturnValue(fixture);

    render(<CostCheckScreen />);

    const sticky = screen.getByTestId('phone-sticky-summary');
    expect(sticky).toBeInTheDocument();
    expect(
      within(sticky).getByText(`$${model.verdictCostUsdt.toFixed(2)} (${model.verdictCostPercent.toFixed(2)}%)`)
    ).toBeInTheDocument();
    expect(within(sticky).getByText(`${model.verdictCostPercent.toFixed(2)}%`)).toBeInTheDocument();
  });

  it('shows n/a in sticky summary and fix message in results when inputs are invalid', () => {
    const fixture = createCostCheckStateFixture({
      inputs: {
        ...DEFAULT_INPUTS,
        leverage: MAX_LEVERAGE + 10,
      },
    });
    mockUseCostCheckState.mockReturnValue(fixture);

    render(<CostCheckScreen />);

    const sticky = screen.getByTestId('phone-sticky-summary');
    const naElements = within(sticky).getAllByText('n/a');
    expect(naElements.length).toBe(2);

    expect(screen.getByText('Fix the highlighted inputs to see the costs.')).toBeInTheDocument();
  });

  it('shows placeholder blocks in sticky summary while initial market load runs', () => {
    const fixture = createCostCheckStateFixture({
      marketData: null,
      marketLoading: true,
    });
    mockUseCostCheckState.mockReturnValue(fixture);

    render(<CostCheckScreen />);

    const sticky = screen.getByTestId('phone-sticky-summary');
    expect(within(sticky).getByTestId('sticky-round-trip-skeleton')).toBeInTheDocument();
    expect(within(sticky).getByTestId('sticky-move-needed-skeleton')).toBeInTheDocument();
    expect(within(sticky).queryByText('n/a')).not.toBeInTheDocument();
  });

  it('calls updateInputs with patch when editing an input', async () => {
    const user = userEvent.setup();
    const updateInputs = vi.fn();
    const fixture = createCostCheckStateFixture({ updateInputs });
    mockUseCostCheckState.mockReturnValue(fixture);

    render(<CostCheckScreen />);

    const radio4h = screen.getByLabelText('4h');
    await user.click(radio4h);
    expect(updateInputs).toHaveBeenCalledWith({ holdMinutes: 240 });
  });

  it('shows inline errors when leverage or hold exceed bounds', () => {
    const fixture = createCostCheckStateFixture({
      inputs: {
        ...DEFAULT_INPUTS,
        leverage: MAX_LEVERAGE + 10,
        holdMinutes: MAX_HOLD_MINUTES + 500,
      },
    });
    mockUseCostCheckState.mockReturnValue(fixture);

    render(<CostCheckScreen />);

    expect(
      screen.getByText(`Leverage cannot exceed ${MAX_LEVERAGE}x.`)
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Hold cannot exceed ${MAX_HOLD_MINUTES.toLocaleString()} minutes (30 days).`)
    ).toBeInTheDocument();
  });

  it('renders market error state and Try again calls retryMarket', async () => {
    const user = userEvent.setup();
    const retryMarket = vi.fn();
    const fixture = createCostCheckStateFixture({
      marketData: null,
      marketProblem: 'the exchange is rate limiting requests',
      retryMarket,
    });
    mockUseCostCheckState.mockReturnValue(fixture);

    render(<CostCheckScreen />);

    expect(
      screen.getByText(/Live market data did not load: the exchange is rate limiting requests/)
    ).toBeInTheDocument();

    const tryAgainBtn = screen.getByRole('button', { name: 'Try again' });
    await user.click(tryAgainBtn);
    expect(retryMarket).toHaveBeenCalledTimes(1);
  });

  it('renders the insufficient-data state when independent windows are below threshold', () => {
    const thinMarket = createMarketFixture({
      move: {
        medianPercent: 0.3,
        meanPercent: 0.4,
        p75Percent: 0.55,
        samples: 150,
        independentWindows: 40,
      },
    });
    const model = computeCostCheck(DEFAULT_INPUTS, thinMarket, NOW);
    const fixture = createCostCheckStateFixture({
      model,
      marketData: thinMarket,
    });
    mockUseCostCheckState.mockReturnValue(fixture);

    render(<CostCheckScreen />);

    expect(
      screen.getByText(/Insufficient data for a verdict: 40 of 100 independent windows/)
    ).toBeInTheDocument();
  });
});
