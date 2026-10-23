import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { CalibrationFilters, type CalibrationFiltersState } from './CalibrationFilters';
import { STYLE_CONFIGS } from '@/lib/indicators/style-configs';

const defaultFilters: CalibrationFiltersState = {
  style: 'day_trading',
  interval: '1h',
  source: 'composite',
  symbol: '',
  configVersion: '4',
  overlapping: false,
};

describe('CalibrationFilters', () => {
  it('renders all filter selects and the overlapping toggle with visible labels', () => {
    const onChange = vi.fn();
    render(
      <CalibrationFilters
        filters={defaultFilters}
        onChange={onChange}
        availableConfigVersions={[4, 5, 6]}
      />
    );

    expect(screen.getByTestId('style-select')).toBeInTheDocument();
    expect(screen.getByTestId('interval-select')).toBeInTheDocument();
    expect(screen.getByTestId('source-select')).toBeInTheDocument();
    expect(screen.getByTestId('symbol-select')).toBeInTheDocument();
    expect(screen.getByTestId('config-version-select')).toBeInTheDocument();
    expect(screen.getByTestId('overlapping-toggle')).toBeInTheDocument();

    expect(screen.getByLabelText('Style')).toBeInTheDocument();
    expect(screen.getByLabelText('Interval')).toBeInTheDocument();
    expect(screen.getByLabelText('Source')).toBeInTheDocument();
    expect(screen.getByLabelText('Coin')).toBeInTheDocument();
    expect(screen.getByLabelText('Config version')).toBeInTheDocument();
    expect(screen.getByLabelText('Sampling')).toBeInTheDocument();
  });

  it('moves the interval to that style first preferred interval and resets config version on style change', () => {
    const onChange = vi.fn();
    render(
      <CalibrationFilters
        filters={defaultFilters}
        onChange={onChange}
        availableConfigVersions={[4, 5]}
      />
    );

    const styleSelect = screen.getByTestId('style-select');
    fireEvent.change(styleSelect, { target: { value: 'swing_trading' } });

    const expectedInterval = STYLE_CONFIGS.swing_trading.preferredIntervals[0];
    expect(onChange).toHaveBeenCalledWith({
      ...defaultFilters,
      style: 'swing_trading',
      interval: expectedInterval,
      configVersion: '',
    });
  });

  it('keeps interval if new style supports it and resets config version', () => {
    const onChange = vi.fn();
    // scalping has 1m, 5m; day_trading has 15m, 1h. swing_trading has 4h, 1d.
    // position_trading has 1d.
    const filters: CalibrationFiltersState = {
      ...defaultFilters,
      style: 'swing_trading',
      interval: '1d',
      configVersion: '5',
    };
    render(
      <CalibrationFilters
        filters={filters}
        onChange={onChange}
        availableConfigVersions={[4, 5]}
      />
    );

    const styleSelect = screen.getByTestId('style-select');
    fireEvent.change(styleSelect, { target: { value: 'position_trading' } });

    expect(onChange).toHaveBeenCalledWith({
      ...filters,
      style: 'position_trading',
      interval: '1d',
      configVersion: '',
    });
  });

  it('resets config version when interval changes', () => {
    const onChange = vi.fn();
    render(
      <CalibrationFilters
        filters={{ ...defaultFilters, configVersion: '4' }}
        onChange={onChange}
        availableConfigVersions={[4, 5]}
      />
    );

    const intervalSelect = screen.getByTestId('interval-select');
    fireEvent.change(intervalSelect, { target: { value: '15m' } });

    expect(onChange).toHaveBeenCalledWith({
      ...defaultFilters,
      interval: '15m',
      configVersion: '',
    });
  });

  it('toggles overlapping state with rule 7 labels', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CalibrationFilters
        filters={{ ...defaultFilters, overlapping: false }}
        onChange={onChange}
      />
    );

    const toggle = screen.getByTestId('overlapping-toggle');
    expect(toggle).toHaveTextContent('Non-overlapping');

    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({
      ...defaultFilters,
      overlapping: true,
    });

    rerender(
      <CalibrationFilters
        filters={{ ...defaultFilters, overlapping: true }}
        onChange={onChange}
      />
    );
    expect(screen.getByTestId('overlapping-toggle')).toHaveTextContent('Overlapping');
  });
});
