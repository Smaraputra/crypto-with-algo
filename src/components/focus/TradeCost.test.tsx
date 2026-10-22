import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INPUTS, STORAGE_KEY } from '@/lib/costs/cost-check-model';
import { pickMeasurementInterval } from '@/lib/costs/move';
import type { CostCheckMarketResponse } from '@/types/cost-check';

const { mockMarket } = vi.hoisted(() => ({
  mockMarket: vi.fn(),
}));

vi.mock('@/hooks/useCostCheck', () => ({
  useCostCheckMarket: (...args: unknown[]) => mockMarket(...args),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { TradeCost } from './TradeCost';

function marketFor(
  holdMinutes: number,
  overrides: Partial<CostCheckMarketResponse> = {}
): CostCheckMarketResponse {
  const measurement = pickMeasurementInterval(holdMinutes * 60_000);
  return {
    symbol: 'BTCUSDT',
    asOf: Date.now(),
    stale: false,
    markPrice: 60000,
    funding: {
      rate: 0.0001,
      intervalHours: 8,
      nextFundingTime: Date.now() + 30 * 60_000,
    },
    venue: {
      minNotional: 100,
      minQty: 0.001,
      stepSize: 0.001,
      tickSize: 0.1,
      effectiveMinNotional: 100,
    },
    measurement: {
      ...measurement,
      barsUsed: 1000,
    },
    move: {
      medianPercent: 0.4,
      meanPercent: 0.5,
      p75Percent: 0.7,
      samples: 900,
      independentWindows: 150,
    },
    slippage: {
      bps: 1,
      source: 'depth',
      halfSpreadBps: 0.5,
      exceedsTopOfBook: false,
    },
    onboardDate: 0,
    ...overrides,
  };
}

function queryResult(
  data?: CostCheckMarketResponse,
  isError = false,
  error: { code?: string; message?: string } | null = null,
  refetch = vi.fn()
) {
  return {
    data,
    isError,
    error,
    isFetching: false,
    isPlaceholderData: false,
    refetch,
  };
}

describe('TradeCost', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockMarket.mockReset();
    mockMarket.mockImplementation((_symbol: string, holdMinutes: number) =>
      queryResult(marketFor(holdMinutes))
    );
  });

  it('shows loading while the market facts load', () => {
    mockMarket.mockReturnValue(queryResult(undefined, false, null));
    render(<TradeCost symbol="BTCUSDT" interval="1h" />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading costs for BTCUSDT...'
    );
  });

  it('shows the error and retries', () => {
    const mockRefetch = vi.fn();
    mockMarket.mockReturnValue(
      queryResult(
        undefined,
        true,
        { code: 'venue_unreachable', message: 'x' },
        mockRefetch
      )
    );
    render(<TradeCost symbol="BTCUSDT" interval="1h" />);
    expect(
      screen.getByText('Could not load costs: the exchange could not be reached.')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('prices three fill pairs with the win rate to break even', () => {
    render(<TradeCost symbol="BTCUSDT" interval="1h" />);
    const rows = screen.getAllByTestId('trade-cost-row');
    expect(rows).toHaveLength(3);

    expect(rows[0]).toHaveTextContent('0.120%');
    expect(rows[0]).toHaveTextContent('1.20 USDT');
    expect(rows[0]).toHaveTextContent('62.0%');

    expect(rows[1]).toHaveTextContent('0.080%');
    expect(rows[1]).toHaveTextContent('58.0%');

    expect(rows[2]).toHaveTextContent('0.040%');
    expect(rows[2]).toHaveTextContent('54.0%');

    expect(screen.getByTestId('evidence-tag')).toHaveTextContent(
      'Context, not a signal'
    );
    expect(
      screen.getByText('1,000 USDT, standard fees, held 1h.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Break-even win rate')
    ).toBeInTheDocument();
  });

  it('takes size from the saved Cost Check settings', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_INPUTS, margin: 50, leverage: 10 })
    );
    render(<TradeCost symbol="BTCUSDT" interval="1h" />);
    expect(mockMarket).toHaveBeenCalledWith('BTCUSDT', 60, 500);
    expect(
      screen.getByText('500 USDT, standard fees, held 1h.')
    ).toBeInTheDocument();
  });

  it('defaults the hold to the chart interval and changes it', () => {
    render(<TradeCost symbol="BTCUSDT" interval="1h" />);
    expect(screen.getByRole('button', { name: '1h' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: '4h' }));
    expect(mockMarket).toHaveBeenLastCalledWith('BTCUSDT', 240, 1000);

    render(<TradeCost symbol="BTCUSDT" interval="15m" />);
    expect(mockMarket).toHaveBeenCalledWith('BTCUSDT', 15, 1000);
  });

  it('withholds the win rate on a thin move', () => {
    mockMarket.mockReturnValue(
      queryResult(
        marketFor(60, {
          move: {
            medianPercent: 0.4,
            meanPercent: 0.5,
            p75Percent: 0.7,
            samples: 900,
            independentWindows: 50,
          },
        })
      )
    );
    render(<TradeCost symbol="BTCUSDT" interval="1h" />);
    expect(
      screen.getByText(
        'Too little history to measure the typical 1h move, so no win rate is shown.'
      )
    ).toBeInTheDocument();
    expect(screen.getAllByText('Not measured')).toHaveLength(3);
  });

  it('reports funding separately', () => {
    render(<TradeCost symbol="BTCUSDT" interval="1h" />);
    expect(
      screen.getByText(
        'Funding +0.0100% per settlement, longs pay. 1 settlement in a 1h hold, not included above.'
      )
    ).toBeInTheDocument();

    mockMarket.mockReturnValue(
      queryResult(
        marketFor(60, {
          funding: {
            rate: 0.0001,
            intervalHours: 8,
            nextFundingTime: Date.now() + 5 * 3_600_000,
          },
        })
      )
    );
    render(<TradeCost symbol="BTCUSDT" interval="1h" />);
    expect(
      screen.getByText('No funding settlement in a 1h hold from now.')
    ).toBeInTheDocument();
  });

  it('flags a stale copy', () => {
    mockMarket.mockReturnValue(
      queryResult(
        marketFor(60, {
          stale: true,
          asOf: Date.now() - 3 * 3_600_000,
        })
      )
    );
    render(<TradeCost symbol="BTCUSDT" interval="1h" />);
    expect(
      screen.getByText(
        'Binance could not be reached. These figures are from 3h ago.'
      )
    ).toBeInTheDocument();
  });

  it('never shows facts measured for another symbol', () => {
    mockMarket.mockReturnValue(
      queryResult(
        marketFor(60, {
          symbol: 'ETHUSDT',
        })
      )
    );
    render(<TradeCost symbol="BTCUSDT" interval="1h" />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading costs for BTCUSDT...'
    );
    expect(screen.queryAllByTestId('trade-cost-row')).toHaveLength(0);
  });

  it('never shows facts measured for another hold', () => {
    mockMarket.mockReturnValue(queryResult(marketFor(240)));
    render(<TradeCost symbol="BTCUSDT" interval="1h" />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading costs for BTCUSDT...'
    );
    expect(screen.queryAllByTestId('trade-cost-row')).toHaveLength(0);
  });

  it('flags a size below the venue minimum', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_INPUTS, margin: 5, leverage: 1 })
    );
    render(<TradeCost symbol="BTCUSDT" interval="1h" />);
    expect(
      screen.getByText(
        "5 USDT is below this perpetual's minimum order of 100 USDT."
      )
    ).toBeInTheDocument();
  });

  it('links to Cost Check with the coin and hold', () => {
    render(<TradeCost symbol="BTCUSDT" interval="1h" />);
    const link = screen.getByRole('link', {
      name: 'Change size or fees in Cost Check',
    });
    expect(link).toHaveAttribute(
      'href',
      '/cost-check?symbol=BTCUSDT&holdMinutes=60'
    );
  });

  it('shows a sub-0.1 bps slippage as under 0.1 bps', () => {
    const { rerender } = render(<TradeCost symbol="BTCUSDT" interval="1h" />);
    expect(
      screen.getByText(/Slippage 1\.0 bps per taker leg, from the order book\./)
    ).toBeInTheDocument();

    mockMarket.mockReturnValue(
      queryResult(
        marketFor(60, {
          slippage: {
            bps: 0.01,
            source: 'depth',
            halfSpreadBps: 0.005,
            exceedsTopOfBook: false,
          },
        })
      )
    );
    rerender(<TradeCost symbol="BTCUSDT" interval="1h" />);
    expect(
      screen.getByText(
        /Slippage under 0\.1 bps per taker leg, from the order book\./
      )
    ).toBeInTheDocument();
  });
});
