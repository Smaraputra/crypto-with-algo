import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_INPUTS, STORAGE_KEY } from '@/lib/costs/cost-check-model';
import type { CostCheckMarketResponse } from '@/types/cost-check';

const marketCalls: Array<[string, number, number]> = [];
const marketData: { current: CostCheckMarketResponse | undefined } = { current: undefined };

vi.mock('@/hooks/useCostCheck', () => ({
  useCostCheckSymbols: () => ({
    data: { symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', onboardDate: 0 }], asOf: 0, stale: false },
    isLoading: false,
    isError: false,
  }),
  useCostCheckMarket: (symbol: string, holdMinutes: number, notional: number) => {
    marketCalls.push([symbol, holdMinutes, notional]);
    return { data: marketData.current, isError: false, error: null, isFetching: false, isPlaceholderData: false };
  },
}));

import { CostCheckView } from './CostCheckView';

function market(): CostCheckMarketResponse {
  return {
    symbol: 'BTCUSDT',
    asOf: Date.now(),
    stale: false,
    markPrice: 60_000,
    funding: { rate: 0, intervalHours: 8, nextFundingTime: Date.now() + 3_600_000 },
    venue: { minNotional: 50, minQty: 0.001, stepSize: 0.001, tickSize: 0.1, effectiveMinNotional: 60 },
    measurement: { interval: '15m', holdBars: 4, measuredHoldMs: 3_600_000, barsUsed: 999 },
    move: { medianPercent: 0.3, meanPercent: 0.4, p75Percent: 0.55, samples: 995, independentWindows: 249 },
    slippage: { bps: 1, source: 'depth', halfSpreadBps: 0.1, exceedsTopOfBook: false },
    onboardDate: 0,
  };
}

describe('CostCheckView', () => {
  beforeEach(() => {
    marketCalls.length = 0;
    marketData.current = market();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/cost-check');
  });

  it('starts from the defaults and asks for the default trade', () => {
    render(<CostCheckView />);
    expect(screen.getByTestId('cost-check-symbol')).toHaveTextContent('BTCUSDT');
    expect(marketCalls.at(-1)).toEqual(['BTCUSDT', 60, 1000]);
    expect(screen.getByTestId('cost-check-tone')).toHaveTextContent('Costs dominate');
  });

  it('opens on the trade in the URL, over saved inputs', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...DEFAULT_INPUTS, symbol: 'ETHUSDT', holdMinutes: 15 }));
    window.history.replaceState(null, '', '/cost-check?holdMinutes=420&notional=248');
    render(<CostCheckView />);
    expect(screen.getByTestId('cost-check-symbol')).toHaveTextContent('ETHUSDT');
    expect(marketCalls.at(-1)).toEqual(['ETHUSDT', 420, 248]);
  });

  it('never prices a new hold with a move measured for the previous one, and saves the inputs', () => {
    render(<CostCheckView />);
    expect(screen.getByTestId('cost-check-tone')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '1w' }));
    // The response on hand was measured on 15m x 4 (a 1h hold); a week is measured on 1d x 7.
    expect(screen.getByTestId('cost-check-verdict')).toHaveTextContent('Measuring the move');
    expect(screen.getByTestId('cost-check-verdict')).toHaveTextContent('for a 7d hold');
    expect(screen.queryByTestId('cost-check-tone')).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) as string).holdMinutes).toBe(10_080);
  });

  it('prices a new hold once its own measurement arrives', () => {
    marketData.current = { ...market(), measurement: { interval: '1d', holdBars: 7, measuredHoldMs: 7 * 86_400_000, barsUsed: 999 }, move: { medianPercent: 6, meanPercent: 8, p75Percent: 10, samples: 990, independentWindows: 142 } };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...DEFAULT_INPUTS, holdMinutes: 10_080 }));
    render(<CostCheckView />);
    expect(screen.getByTestId('cost-check-verdict')).toHaveTextContent('of a 7d hold');
  });

  it('labels slippage measured for the previous size while the new size is pending', () => {
    vi.useFakeTimers();
    try {
      render(<CostCheckView />);
      fireEvent.change(screen.getByLabelText('Margin'), { target: { value: '250' } });
      expect(screen.getByTestId('cost-check-breakdown')).toHaveTextContent('measured for the previous size, updating');
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.getByTestId('cost-check-breakdown')).toHaveTextContent('measured from the order book for this size');
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces size changes before asking the server again', () => {
    vi.useFakeTimers();
    try {
      render(<CostCheckView />);
      const margin = screen.getByLabelText('Margin');
      fireEvent.change(margin, { target: { value: '250' } });
      expect(marketCalls.at(-1)?.[2]).toBe(1000);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(marketCalls.at(-1)?.[2]).toBe(2500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last valid value while a number is half typed or out of range', () => {
    render(<CostCheckView />);
    const leverage = screen.getByLabelText('Leverage');
    fireEvent.change(leverage, { target: { value: '500' } });
    expect(leverage).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a number from 1 to 125.');
    expect(screen.getByText(/a round trip costs/)).toHaveTextContent('At 10x a round trip costs 1.20% of the margin');
  });
});
