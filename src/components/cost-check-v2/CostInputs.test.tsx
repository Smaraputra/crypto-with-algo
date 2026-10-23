import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CostInputs } from './CostInputs';
import { DEFAULT_INPUTS, MAX_HOLD_MINUTES, MAX_LEVERAGE, type CostCheckInputs } from '@/lib/costs/cost-check-model';

describe('CostInputs', () => {
  const mockSymbols = {
    list: [
      { symbol: 'BTCUSDT', baseAsset: 'BTC', onboardDate: 1568000000000 },
      { symbol: 'ETHUSDT', baseAsset: 'ETH', onboardDate: 1570000000000 },
    ],
    isLoading: false,
    isError: false,
  };

  it('renders inputs with initial values and shows notional size', () => {
    const updateInputs = vi.fn();
    const { container } = render(
      <CostInputs
        inputs={DEFAULT_INPUTS}
        updateInputs={updateInputs}
        symbols={mockSymbols}
      />
    );

    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByLabelText('Margin (USDT)')).toHaveValue(100);
    expect(screen.getByLabelText('Leverage')).toHaveValue(10);
    expect(screen.getByTestId('notional-display')).toHaveTextContent('Position size: $1,000');
    expect(screen.getByText('Between 1x and 125x')).toBeInTheDocument();

    expect(container.textContent).not.toMatch(/\bbuy\b|\bsell\b|safe|recommend/i);
  });

  it('calls updateInputs with patch when editing margin and leverage', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    function Wrapper() {
      const [inputs, setInputs] = useState<CostCheckInputs>(DEFAULT_INPUTS);
      return (
        <CostInputs
          inputs={inputs}
          updateInputs={(patch) => {
            onUpdate(patch);
            setInputs((prev) => ({ ...prev, ...patch }));
          }}
          symbols={mockSymbols}
        />
      );
    }

    render(<Wrapper />);

    const marginInput = screen.getByLabelText('Margin (USDT)');
    await user.clear(marginInput);
    expect(screen.getByText('Enter a number.')).toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalledWith({ margin: 0 });

    await user.type(marginInput, '250');
    expect(onUpdate).toHaveBeenCalledWith({ margin: 250 });

    const leverageInput = screen.getByLabelText('Leverage');
    await user.clear(leverageInput);
    expect(screen.getByText('Enter a number.')).toBeInTheDocument();
    await user.type(leverageInput, '20');
    expect(onUpdate).toHaveBeenCalledWith({ leverage: 20 });
  });

  it('shows inline error when leverage is above MAX_LEVERAGE', () => {
    const updateInputs = vi.fn();
    render(
      <CostInputs
        inputs={{ ...DEFAULT_INPUTS, leverage: MAX_LEVERAGE + 5 }}
        updateInputs={updateInputs}
        symbols={mockSymbols}
      />
    );

    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent(`Leverage cannot exceed ${MAX_LEVERAGE}x.`);
  });

  it('shows inline error when holdMinutes is above MAX_HOLD_MINUTES', () => {
    const updateInputs = vi.fn();
    render(
      <CostInputs
        inputs={{ ...DEFAULT_INPUTS, holdMinutes: MAX_HOLD_MINUTES + 100 }}
        updateInputs={updateInputs}
        symbols={mockSymbols}
      />
    );

    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent(
      `Hold cannot exceed ${MAX_HOLD_MINUTES.toLocaleString()} minutes (30 days).`
    );
  });

  it('calls updateInputs when clicking a preset hold or direction', async () => {
    const user = userEvent.setup();
    const updateInputs = vi.fn();

    render(
      <CostInputs
        inputs={DEFAULT_INPUTS}
        updateInputs={updateInputs}
        symbols={mockSymbols}
      />
    );

    const radio4h = screen.getByLabelText('4h');
    await user.click(radio4h);
    expect(updateInputs).toHaveBeenCalledWith({ holdMinutes: 240 });

    const shortRadio = screen.getByLabelText('Short');
    await user.click(shortRadio);
    expect(updateInputs).toHaveBeenCalledWith({ side: 'short' });
  });

  it('shows loading state for symbols', () => {
    const updateInputs = vi.fn();
    render(
      <CostInputs
        inputs={DEFAULT_INPUTS}
        updateInputs={updateInputs}
        symbols={{ list: undefined, isLoading: true, isError: false }}
      />
    );

    expect(screen.getByText('Loading coins...')).toBeInTheDocument();
  });
});
