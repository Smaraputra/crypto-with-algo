import { describe, it, expect } from 'vitest';
import { INDICATOR_PARAMS, getDefaultCalcParams } from './indicator-params';

describe('INDICATOR_PARAMS', () => {
  it('defines params for all 9 indicators', () => {
    const ids = Object.keys(INDICATOR_PARAMS);
    expect(ids).toHaveLength(9);
    expect(ids).toEqual(['MA', 'EMA', 'BOLL', 'SAR', 'MACD', 'RSI', 'KDJ', 'VOL', 'OBV']);
  });

  it('MA has 4 period params', () => {
    expect(INDICATOR_PARAMS.MA).toHaveLength(4);
    expect(INDICATOR_PARAMS.MA[0].defaultValue).toBe(5);
    expect(INDICATOR_PARAMS.MA[3].defaultValue).toBe(60);
  });

  it('MACD has fast, slow, signal params', () => {
    expect(INDICATOR_PARAMS.MACD).toHaveLength(3);
    expect(INDICATOR_PARAMS.MACD.map((p) => p.label)).toEqual(['Fast', 'Slow', 'Signal']);
    expect(INDICATOR_PARAMS.MACD.map((p) => p.defaultValue)).toEqual([12, 26, 9]);
  });

  it('all params have min < max', () => {
    for (const [, params] of Object.entries(INDICATOR_PARAMS)) {
      for (const param of params) {
        expect(param.min).toBeLessThan(param.max);
      }
    }
  });

  it('all default values are within min/max range', () => {
    for (const [, params] of Object.entries(INDICATOR_PARAMS)) {
      for (const param of params) {
        expect(param.defaultValue).toBeGreaterThanOrEqual(param.min);
        expect(param.defaultValue).toBeLessThanOrEqual(param.max);
      }
    }
  });
});

describe('getDefaultCalcParams', () => {
  it('returns default values for MA', () => {
    expect(getDefaultCalcParams('MA')).toEqual([5, 10, 30, 60]);
  });

  it('returns default values for BOLL', () => {
    expect(getDefaultCalcParams('BOLL')).toEqual([20, 2]);
  });

  it('returns default values for RSI', () => {
    expect(getDefaultCalcParams('RSI')).toEqual([6, 12, 24]);
  });

  it('returns empty array for unknown indicator', () => {
    expect(getDefaultCalcParams('UNKNOWN')).toEqual([]);
  });
});
