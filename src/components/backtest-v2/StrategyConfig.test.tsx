import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React, { useState } from 'react';
import { StrategyConfig } from './StrategyConfig';
import { DEFAULT_BACKTEST_CONFIG, type BacktestConfig } from '@/lib/backtest/types';
import type { DataRange } from '@/lib/backtest/options';
import { DEFAULT_WEIGHTS } from '@/types/signal';
import { useStrategies, useCreateStrategy, useUpdateStrategy, useDeleteStrategy } from '@/hooks/useStrategies';

vi.mock('@/hooks/useStrategies', () => ({
  useStrategies: vi.fn(),
  useCreateStrategy: vi.fn(),
  useUpdateStrategy: vi.fn(),
  useDeleteStrategy: vi.fn(),
}));

// Mock global fetch for candle range
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('StrategyConfig', () => {
  const mockMutateCreate = vi.fn();
  const mockMutateUpdate = vi.fn();
  const mockMutateDelete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useStrategies).mockReturnValue({
      data: {
        strategies: [
          {
            _id: 'strat-1',
            userId: 'user-1',
            name: 'Momentum Trend',
            symbols: ['BTCUSDT'],
            intervals: ['1h'],
            weights: {
              trend: 0.3,
              momentum: 0.3,
              volume: 0.1,
              volatility: 0.1,
              futures: 0.1,
              sentiment: 0.1,
              // htf intentionally omitted
            },
            active: true,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
          },
        ],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useStrategies>);

    vi.mocked(useCreateStrategy).mockReturnValue({
      mutateAsync: mockMutateCreate,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateStrategy>);

    vi.mocked(useUpdateStrategy).mockReturnValue({
      mutateAsync: mockMutateUpdate,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateStrategy>);

    vi.mocked(useDeleteStrategy).mockReturnValue({
      mutateAsync: mockMutateDelete,
      isPending: false,
    } as unknown as ReturnType<typeof useDeleteStrategy>);

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        count: 1500,
        oldest: 1736035200000, // Jan 5, 2025 UTC
        newest: 1738713600000, // Feb 5, 2025 UTC
      }),
    });
  });

  const WrapperComponent = ({
    initialConfig = DEFAULT_BACKTEST_CONFIG,
    initialStrategyId = null,
  }: {
    initialConfig?: BacktestConfig;
    initialStrategyId?: string | null;
  }) => {
    const [config, setConfig] = useState<BacktestConfig>(initialConfig);
    const [symbol, setSymbol] = useState('BTCUSDT');
    const [interval, setInterval] = useState('1h');
    const [dataRange, setDataRange] = useState<DataRange>('6m');
    const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(initialStrategyId);

    return (
      <div>
        <StrategyConfig
          symbol={symbol}
          onSymbolChange={setSymbol}
          interval={interval}
          onIntervalChange={setInterval}
          dataRange={dataRange}
          onDataRangeChange={setDataRange}
          config={config}
          onConfigChange={setConfig}
          selectedStrategyId={selectedStrategyId}
          onSelectedStrategyIdChange={setSelectedStrategyId}
        />
        <div data-testid="debug-stop-loss">{config.stopLossPercent}</div>
        <div data-testid="debug-weights">{JSON.stringify(config.weights)}</div>
      </div>
    );
  };

  it('the config maps percents to fractions in BacktestConfig, and Reset restores DEFAULT_WEIGHTS', async () => {
    render(<WrapperComponent />);

    const stopLossInput = screen.getByLabelText('Stop loss (%)');
    expect(stopLossInput).toHaveValue(5); // 0.05 * 100 = 5

    fireEvent.change(stopLossInput, { target: { value: '8' } });
    expect(screen.getByTestId('debug-stop-loss')).toHaveTextContent('0.08');

    // Change trend weight range input
    const trendSlider = screen.getByLabelText(/^Trend/i);
    fireEvent.change(trendSlider, { target: { value: '50' } });

    // Click Reset to defaults
    const resetButton = screen.getByRole('button', { name: 'Reset to defaults' });
    fireEvent.click(resetButton);

    const weightsDebug = screen.getByTestId('debug-weights').textContent;
    const parsedWeights = JSON.parse(weightsDebug || '{}');
    expect(parsedWeights).toEqual(DEFAULT_WEIGHTS);
  });

  it('choosing a strategy without htf sets the run weights with htf: 0; strategy save controls are disabled when the weights total is not 100%', async () => {
    render(<WrapperComponent />);

    const strategySelect = screen.getByLabelText('Strategy');
    fireEvent.change(strategySelect, { target: { value: 'strat-1' } });

    // The weights should have htf: 0
    const weightsDebug = screen.getByTestId('debug-weights').textContent;
    const parsedWeights = JSON.parse(weightsDebug || '{}');
    expect(parsedWeights.htf).toBe(0);
    expect(parsedWeights.trend).toBe(0.3);

    // Now change weights so total is not 100%
    const trendSlider = screen.getByLabelText(/^Trend/i);
    fireEvent.change(trendSlider, { target: { value: '10' } }); // total drops to 80%

    // Save controls should be disabled and note should show
    expect(screen.getByText(/Weights total 80%\. A strategy needs 100%\./)).toBeInTheDocument();
    const newStrategyBtn = screen.getByRole('button', { name: 'New strategy' });
    expect(newStrategyBtn).toBeDisabled();

    const saveWeightsBtn = screen.getByRole('button', { name: 'Save weights to strategy' });
    expect(saveWeightsBtn).toBeDisabled();
  });

  it('creating a strategy sends only name, symbols, intervals and weights', async () => {
    mockMutateCreate.mockResolvedValueOnce({
      strategy: {
        _id: 'strat-new',
        name: 'New Trend',
      },
    });

    render(<WrapperComponent />);

    const newStrategyBtn = screen.getByRole('button', { name: 'New strategy' });
    fireEvent.click(newStrategyBtn);

    const nameInput = screen.getByLabelText('Strategy name');
    fireEvent.change(nameInput, { target: { value: 'New Trend' } });

    const submitBtn = screen.getByRole('button', { name: 'Create strategy' });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockMutateCreate).toHaveBeenCalledTimes(1);
    });

    const callPayload = mockMutateCreate.mock.calls[0][0];
    expect(Object.keys(callPayload).sort()).toEqual(['intervals', 'name', 'symbols', 'weights']);
    expect(callPayload.name).toBe('New Trend');
    expect(callPayload.symbols).toEqual(['BTCUSDT']);
    expect(callPayload.intervals).toEqual(['1h']);
    expect(callPayload.weights).toEqual(DEFAULT_WEIGHTS);
  });

  it('opens New strategy as a labelled dialog with named checkbox groups and closes on Escape', async () => {
    render(<WrapperComponent />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New strategy' }));

    const dialog = await screen.findByRole('dialog', { name: 'New strategy' });
    expect(dialog).toHaveTextContent('A strategy saves its coins, intervals and weights.');
    expect(screen.getByRole('group', { name: 'Coins (1 to 5)' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Intervals (at least one)' })).toBeInTheDocument();

    const coinCheckbox = screen.getByRole('checkbox', { name: 'BTC' });
    expect(coinCheckbox).toHaveClass('w-5', 'h-5');
    const coinLabel = coinCheckbox.closest('label');
    expect(coinLabel).toHaveClass('min-h-[44px]');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('the coin select option text is "BTC" with value "BTCUSDT"', () => {
    render(<WrapperComponent />);

    const btcOption = screen.getByRole('option', { name: 'BTC' }) as HTMLOptionElement;
    expect(btcOption).toBeInTheDocument();
    expect(btcOption.value).toBe('BTCUSDT');
    expect(btcOption.textContent).toBe('BTC');
  });

  it('every disclosure starts closed', () => {
    const { container } = render(<WrapperComponent />);

    const details = container.querySelectorAll('details');
    expect(details.length).toBe(6);
    details.forEach((d) => {
      expect(d.open).toBe(false);
    });
  });

  it('clearing the stop loss shows "Enter a number." and does not call onConfigChange with 0', () => {
    render(<WrapperComponent />);

    const stopLossInput = screen.getByLabelText('Stop loss (%)');
    expect(stopLossInput).toHaveValue(5);

    fireEvent.change(stopLossInput, { target: { value: '' } });

    expect(screen.getByText('Enter a number.')).toBeInTheDocument();
    expect(screen.getByTestId('debug-stop-loss')).toHaveTextContent('0.05');
  });
});
