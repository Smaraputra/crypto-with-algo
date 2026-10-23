import { useSyncExternalStore } from 'react';
import { subscribeTheme } from './theme';

export interface ChartTheme {
  grid: string;
  crosshair: string;
  up: string;
  down: string;
  volume: string;
  text: string;
  mutedText: string;
  line: string;
  accentLine: string;
}

export const LIGHT_CHART_THEME_FALLBACK: ChartTheme = {
  grid: '#E2E5E9',
  crosshair: '#7C8490',
  up: '#067346',
  down: '#C21F36',
  volume: '#E4E7EB',
  text: '#0F1114',
  mutedText: '#59606B',
  line: '#E2E5E9',
  accentLine: '#B03E00',
};

export function getChartTheme(): ChartTheme {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return LIGHT_CHART_THEME_FALLBACK;
  }

  const styles = window.getComputedStyle(document.documentElement);
  const readVar = (name: string, fallback: string): string => {
    const val = styles.getPropertyValue(name).trim();
    return val || fallback;
  };

  return {
    grid: readVar('--chart-grid-hex', LIGHT_CHART_THEME_FALLBACK.grid),
    crosshair: readVar('--chart-crosshair-hex', LIGHT_CHART_THEME_FALLBACK.crosshair),
    up: readVar('--chart-up-hex', LIGHT_CHART_THEME_FALLBACK.up),
    down: readVar('--chart-down-hex', LIGHT_CHART_THEME_FALLBACK.down),
    volume: readVar('--chart-volume-hex', LIGHT_CHART_THEME_FALLBACK.volume),
    text: readVar('--foreground', LIGHT_CHART_THEME_FALLBACK.text),
    mutedText: readVar('--muted-foreground', LIGHT_CHART_THEME_FALLBACK.mutedText),
    line: readVar('--line', LIGHT_CHART_THEME_FALLBACK.line),
    accentLine: readVar('--brand-line', LIGHT_CHART_THEME_FALLBACK.accentLine),
  };
}

export function subscribeChartTheme(cb: () => void): () => void {
  return subscribeTheme(cb);
}

let cachedTheme: ChartTheme = LIGHT_CHART_THEME_FALLBACK;

function areThemesEqual(a: ChartTheme, b: ChartTheme): boolean {
  return (
    a.grid === b.grid &&
    a.crosshair === b.crosshair &&
    a.up === b.up &&
    a.down === b.down &&
    a.volume === b.volume &&
    a.text === b.text &&
    a.mutedText === b.mutedText &&
    a.line === b.line &&
    a.accentLine === b.accentLine
  );
}

function getSnapshot(): ChartTheme {
  const next = getChartTheme();
  if (areThemesEqual(cachedTheme, next)) {
    return cachedTheme;
  }
  cachedTheme = next;
  return cachedTheme;
}

function getServerSnapshot(): ChartTheme {
  return LIGHT_CHART_THEME_FALLBACK;
}

export function useChartTheme(): ChartTheme {
  return useSyncExternalStore(subscribeChartTheme, getSnapshot, getServerSnapshot);
}
