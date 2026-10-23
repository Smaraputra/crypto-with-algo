import { beforeEach, describe, expect, it } from 'vitest';
import { LIGHT_CHART_THEME_FALLBACK, type ChartTheme } from '@/lib/chart-theme';
import { getIndicatorTheme, setIndicatorTheme, withAlpha } from './indicator-theme';

describe('indicator-theme', () => {
  beforeEach(() => {
    setIndicatorTheme(LIGHT_CHART_THEME_FALLBACK);
  });

  it('defaults to LIGHT_CHART_THEME_FALLBACK', () => {
    expect(getIndicatorTheme()).toEqual(LIGHT_CHART_THEME_FALLBACK);
  });

  it('updates and gets the current theme via setter and getter', () => {
    const customTheme: ChartTheme = {
      grid: '#111111',
      crosshair: '#222222',
      up: '#333333',
      down: '#444444',
      volume: '#555555',
      text: '#666666',
      mutedText: '#777777',
      line: '#888888',
      accentLine: '#999999',
    };

    setIndicatorTheme(customTheme);
    expect(getIndicatorTheme()).toEqual(customTheme);
  });

  it('converts hex to rgba with opacity via withAlpha helper', () => {
    expect(withAlpha('#067346', 0.6)).toBe('rgba(6, 115, 70, 0.6)');
    expect(withAlpha('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
    expect(withAlpha('#000000', 1)).toBe('rgba(0, 0, 0, 1)');
  });
});
