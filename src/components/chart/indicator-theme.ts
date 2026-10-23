import { LIGHT_CHART_THEME_FALLBACK, type ChartTheme } from '@/lib/chart-theme';

let currentTheme: ChartTheme = LIGHT_CHART_THEME_FALLBACK;

export function setIndicatorTheme(theme: ChartTheme): void {
  currentTheme = theme;
}

export function getIndicatorTheme(): ChartTheme {
  return currentTheme;
}

export function withAlpha(hex: string, alpha: number): string {
  const cleanHex = hex.replace('#', '').trim();
  let r = 0;
  let g = 0;
  let b = 0;

  if (cleanHex.length === 3) {
    r = parseInt(cleanHex[0] + cleanHex[0], 16);
    g = parseInt(cleanHex[1] + cleanHex[1], 16);
    b = parseInt(cleanHex[2] + cleanHex[2], 16);
  } else if (cleanHex.length === 6) {
    r = parseInt(cleanHex.substring(0, 2), 16);
    g = parseInt(cleanHex.substring(2, 4), 16);
    b = parseInt(cleanHex.substring(4, 6), 16);
  }

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
