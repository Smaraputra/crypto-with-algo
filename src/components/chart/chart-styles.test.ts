import { describe, expect, it } from 'vitest';
import type { ChartTheme } from '@/lib/chart-theme';
import { buildChartStyles } from './chart-styles';

describe('buildChartStyles', () => {
  const sampleTheme: ChartTheme = {
    grid: '#112233',
    crosshair: '#445566',
    up: '#00cc66',
    down: '#ee3344',
    volume: '#556677',
    text: '#ffffff',
    mutedText: '#8899aa',
    line: '#223344',
    accentLine: '#ffbb00',
  };

  it('maps grid lines to theme.grid', () => {
    const styles = buildChartStyles(sampleTheme);
    expect(styles.grid?.show).toBe(true);
    expect(styles.grid?.horizontal?.color).toBe(sampleTheme.grid);
    expect(styles.grid?.vertical?.color).toBe(sampleTheme.grid);
  });

  it('maps axis lines, tick lines and separator to theme.line', () => {
    const styles = buildChartStyles(sampleTheme);
    expect(styles.xAxis?.axisLine?.color).toBe(sampleTheme.line);
    expect(styles.xAxis?.tickLine?.color).toBe(sampleTheme.line);
    expect(styles.yAxis?.axisLine?.color).toBe(sampleTheme.line);
    expect(styles.yAxis?.tickLine?.color).toBe(sampleTheme.line);
    expect(styles.separator?.color).toBe(sampleTheme.line);
  });

  it('maps axis tick text to theme.mutedText', () => {
    const styles = buildChartStyles(sampleTheme);
    expect(styles.xAxis?.tickText?.color).toBe(sampleTheme.mutedText);
    expect(styles.yAxis?.tickText?.color).toBe(sampleTheme.mutedText);
  });

  it('maps candle up, high mark and up border to theme.up', () => {
    const styles = buildChartStyles(sampleTheme);
    expect(styles.candle?.priceMark?.high?.color).toBe(sampleTheme.up);
    expect(styles.candle?.bar?.upColor).toBe(sampleTheme.up);
    expect(styles.candle?.bar?.upBorderColor).toBe(sampleTheme.up);
  });

  it('maps candle down, low mark and down border to theme.down', () => {
    const styles = buildChartStyles(sampleTheme);
    expect(styles.candle?.priceMark?.low?.color).toBe(sampleTheme.down);
    expect(styles.candle?.bar?.downColor).toBe(sampleTheme.down);
    expect(styles.candle?.bar?.downBorderColor).toBe(sampleTheme.down);
  });

  it('maps no-change bar and border to theme.mutedText', () => {
    const styles = buildChartStyles(sampleTheme);
    expect(styles.candle?.bar?.noChangeColor).toBe(sampleTheme.mutedText);
    expect(styles.candle?.bar?.noChangeBorderColor).toBe(sampleTheme.mutedText);
  });

  it('maps crosshair lines to theme.crosshair with dashed style', () => {
    const styles = buildChartStyles(sampleTheme);
    expect(styles.crosshair?.show).toBe(true);
    expect(styles.crosshair?.horizontal?.line?.color).toBe(sampleTheme.crosshair);
    expect(styles.crosshair?.horizontal?.line?.style).toBe('dashed');
    expect(styles.crosshair?.vertical?.line?.color).toBe(sampleTheme.crosshair);
    expect(styles.crosshair?.vertical?.line?.style).toBe('dashed');
  });

  it('preserves non-color options', () => {
    const styles = buildChartStyles(sampleTheme);
    expect(styles.candle?.type).toBe('candle_solid');
    expect(styles.candle?.priceMark?.show).toBe(true);
    expect(styles.candle?.priceMark?.high?.show).toBe(true);
    expect(styles.candle?.priceMark?.low?.show).toBe(true);
    expect(styles.candle?.priceMark?.last?.show).toBe(true);
    expect(styles.indicator?.lastValueMark?.show).toBe(true);
  });
});
