import type { DeepPartial, Styles } from 'klinecharts';
import type { ChartTheme } from '@/lib/chart-theme';

export interface BuildChartStylesOptions {
  showCandleTooltip?: boolean;
}

export function buildChartStyles(
  theme: ChartTheme,
  options?: BuildChartStylesOptions
): DeepPartial<Styles> {
  const showCandleTooltip = options?.showCandleTooltip ?? true;
  return {
    grid: {
      show: true,
      horizontal: { color: theme.grid },
      vertical: { color: theme.grid },
    },
    candle: {
      type: 'candle_solid',
      tooltip: {
        showRule: showCandleTooltip ? 'always' : 'none',
      },
      priceMark: {
        show: true,
        high: { show: true, color: theme.up },
        low: { show: true, color: theme.down },
        last: { show: true },
      },
      bar: {
        upColor: theme.up,
        downColor: theme.down,
        noChangeColor: theme.mutedText,
        upBorderColor: theme.up,
        downBorderColor: theme.down,
        noChangeBorderColor: theme.mutedText,
      },
    },
    indicator: {
      lastValueMark: { show: true },
    },
    xAxis: {
      axisLine: { color: theme.line },
      tickLine: { color: theme.line },
      tickText: { color: theme.mutedText },
    },
    yAxis: {
      axisLine: { color: theme.line },
      tickLine: { color: theme.line },
      tickText: { color: theme.mutedText },
    },
    crosshair: {
      show: true,
      horizontal: {
        line: { color: theme.crosshair, style: 'dashed' },
      },
      vertical: {
        line: { color: theme.crosshair, style: 'dashed' },
      },
    },
    separator: {
      color: theme.line,
    },
  };
}
