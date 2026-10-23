import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIGHT_CHART_THEME_FALLBACK,
  getChartTheme,
  subscribeChartTheme,
  useChartTheme,
} from './chart-theme';

describe('chart-theme', () => {
  const customVariables: Record<string, string> = {
    '--chart-grid-hex': '#111111',
    '--chart-crosshair-hex': '#222222',
    '--chart-up-hex': '#333333',
    '--chart-down-hex': '#444444',
    '--chart-volume-hex': '#555555',
    '--foreground': '#666666',
    '--muted-foreground': '#777777',
    '--line': '#888888',
    '--brand-line': '#999999',
  };

  beforeEach(() => {
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
  });

  afterEach(() => {
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
    vi.restoreAllMocks();
  });

  it('returns the fallbacks when CSS variables are missing', () => {
    const theme = getChartTheme();
    expect(theme).toEqual(LIGHT_CHART_THEME_FALLBACK);
  });

  it('returns custom values when CSS variables are set on documentElement via style.setProperty', () => {
    for (const [key, value] of Object.entries(customVariables)) {
      document.documentElement.style.setProperty(key, value);
    }

    const theme = getChartTheme();

    expect(theme.grid).toBe('#111111');
    expect(theme.crosshair).toBe('#222222');
    expect(theme.up).toBe('#333333');
    expect(theme.down).toBe('#444444');
    expect(theme.volume).toBe('#555555');
    expect(theme.text).toBe('#666666');
    expect(theme.mutedText).toBe('#777777');
    expect(theme.line).toBe('#888888');
    expect(theme.accentLine).toBe('#999999');
  });

  it('fires subscribeChartTheme when the dark class toggles', async () => {
    const callback = vi.fn();
    const unsubscribe = subscribeChartTheme(callback);

    document.documentElement.classList.toggle('dark');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callback).toHaveBeenCalled();

    callback.mockClear();
    unsubscribe();

    document.documentElement.classList.toggle('dark');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callback).not.toHaveBeenCalled();
  });

  it('provides a theme object via useChartTheme hook', () => {
    const { result } = renderHook(() => useChartTheme());
    expect(result.current).toEqual(LIGHT_CHART_THEME_FALLBACK);
  });
});
