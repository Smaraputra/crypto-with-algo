import { registerIndicator, type KLineData } from 'klinecharts';
import type { OHLCV } from '@/types/market';
import {
  analyzeStructure,
  INTERNAL_LENGTH,
  SWING_LENGTH,
  type Direction,
  type PivotKind,
  type StructureEventType,
  type SwingLabel,
} from '@/lib/market/structure';
import { barDelta, barWinner, cvdSeries, type BarWinner } from '@/lib/market/delta';

export const STRUCTURE_INDICATOR = 'STRUCTURE';
export const DELTA_VOL_INDICATOR = 'DELTA_VOL';
export const CVD_INDICATOR = 'CVD';

export const DELTA_VOL_PANE_ID = 'delta_vol_pane';
export const CVD_PANE_ID = 'cvd_pane';

export const DELTA_VOL_PANE_HEIGHT = 90;
export const CVD_PANE_HEIGHT = 80;

export const MAX_PIVOT_LABELS = 6;
export const MAX_EVENTS = 4;

export const FOCUS_COLORS = {
  bullish: '#0ecb81',
  bearish: '#f6465d',
  accent: '#f0b90b',
  muted: '#848e9c',
} as const;

export interface StructurePivotLabel {
  label: SwingLabel;
  kind: PivotKind;
}

export interface StructureEventMark {
  type: StructureEventType;
  direction: Direction;
  level: number;
  pivotIndex: number;
  breakIndex?: number;
  latest?: boolean;
  internal?: boolean;
}

export interface StructureDatum {
  pivotLabel?: StructurePivotLabel;
  events?: StructureEventMark[];
}

export interface PriorDayLevels {
  high: number;
  low: number;
  close: number;
}

export interface StructureExtend {
  priorDay: PriorDayLevels | null;
  labMarks?: { time: number; side: 1 | -1; label: 'S1' | 'S2' }[];
}

export interface StructureCalcOptions {
  intervalMs: number;
  now?: () => number;
  showInternal?: boolean;
}

export interface DeltaVolDatum {
  volume: number;
  delta: number | null;
  winner: BarWinner | null;
}

export interface CvdDatum {
  cvd: number | null;
}

export interface FormatFlowOptions {
  signed?: boolean;
}

/**
 * Formats a flow or volume quantity:
 * - |value| >= 1000: no decimals, thousands separators (en-US)
 * - |value| >= 1: 2 decimals
 * - smaller: 4 decimals
 * - leading '+' for positive numbers when signed option is true
 */
export function formatFlow(value: number, options?: FormatFlowOptions): string {
  const abs = Math.abs(value);
  const fractionDigits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
  const formatted = value.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  if (options?.signed && value > 0) {
    return `+${formatted}`;
  }
  return formatted;
}

/**
 * Creates a calculation function for market structure indicators on price pane.
 * Drops forming bars (timestamp + intervalMs > now()), then identifies swing pivots/events
 * (and optionally internal structure), capped by MAX_PIVOT_LABELS and MAX_EVENTS.
 */
export function makeStructureCalc(options: StructureCalcOptions) {
  const { intervalMs, now, showInternal = false } = options;
  const nowFn = now ?? (() => Date.now());

  return (dataList: KLineData[]): StructureDatum[] => {
    const currentNow = nowFn();
    const closedCandles: OHLCV[] = [];
    for (let i = 0; i < dataList.length; i++) {
      const k = dataList[i];
      if (k.timestamp + intervalMs > currentNow) {
        break;
      }
      closedCandles.push({
        timestamp: k.timestamp,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume ?? 0,
        takerBuyVolume: (k as { takerBuyVolume?: number }).takerBuyVolume,
      });
    }

    const results: StructureDatum[] = Array.from({ length: dataList.length }, () => ({}));
    if (closedCandles.length === 0) {
      return results;
    }

    const swingResult = analyzeStructure(closedCandles, SWING_LENGTH);

    // Keep only the last MAX_PIVOT_LABELS pivot labels
    const labeledPivots = swingResult.pivots.filter(
      (p): p is typeof p & { label: SwingLabel } => p.label !== null
    );
    const keptPivots = labeledPivots.slice(-MAX_PIVOT_LABELS);
    for (const p of keptPivots) {
      if (p.index >= 0 && p.index < results.length) {
        results[p.index].pivotLabel = {
          label: p.label,
          kind: p.kind,
        };
      }
    }

    // Keep only the last MAX_EVENTS swing events, marking the last one with latest: true
    const keptSwingEvents = swingResult.events.slice(-MAX_EVENTS);
    const lastSwingIndex = keptSwingEvents.length - 1;
    for (let i = 0; i < keptSwingEvents.length; i++) {
      const ev = keptSwingEvents[i];
      const isLatest = i === lastSwingIndex;
      const mark: StructureEventMark = {
        type: ev.type,
        direction: ev.direction,
        level: ev.level,
        pivotIndex: ev.pivotIndex,
        breakIndex: ev.breakIndex,
        ...(isLatest ? { latest: true } : {}),
      };
      if (ev.breakIndex >= 0 && ev.breakIndex < results.length) {
        if (!results[ev.breakIndex].events) {
          results[ev.breakIndex].events = [];
        }
        results[ev.breakIndex].events!.push(mark);
      }
    }

    // When showInternal is enabled: up to MAX_EVENTS internal events flagged internal: true
    if (showInternal) {
      const internalResult = analyzeStructure(closedCandles, INTERNAL_LENGTH);
      const keptInternalEvents = internalResult.events.slice(-MAX_EVENTS);
      for (const ev of keptInternalEvents) {
        const mark: StructureEventMark = {
          type: ev.type,
          direction: ev.direction,
          level: ev.level,
          pivotIndex: ev.pivotIndex,
          breakIndex: ev.breakIndex,
          internal: true,
        };
        if (ev.breakIndex >= 0 && ev.breakIndex < results.length) {
          if (!results[ev.breakIndex].events) {
            results[ev.breakIndex].events = [];
          }
          results[ev.breakIndex].events!.push(mark);
        }
      }
    }

    return results;
  };
}

/**
 * Creates calculation function for volume bars with delta and winner determination.
 */
export function makeDeltaVolCalc() {
  return (dataList: KLineData[]): DeltaVolDatum[] =>
    dataList.map((k) => {
      const vol = k.volume ?? 0;
      const candle: OHLCV = {
        timestamp: k.timestamp,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: vol,
        takerBuyVolume: (k as { takerBuyVolume?: number }).takerBuyVolume,
      };
      return {
        volume: vol,
        delta: barDelta(candle),
        winner: barWinner(candle),
      };
    });
}

const DAY_MS = 86_400_000;

/**
 * Creates calculation function for cumulative volume delta with daily reset at 00:00 UTC.
 */
export function makeCvdCalc() {
  return (dataList: KLineData[]): CvdDatum[] => {
    const candles: OHLCV[] = dataList.map((k) => ({
      timestamp: k.timestamp,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume ?? 0,
      takerBuyVolume: (k as { takerBuyVolume?: number }).takerBuyVolume,
    }));
    const series = cvdSeries(candles, { resetDaily: true });
    const firstMidnightIdx = series.findIndex((p) => p.timestamp % DAY_MS === 0);
    const cutoff = firstMidnightIdx === -1 ? series.length : firstMidnightIdx;

    return series.map((p, i) => ({
      cvd: i < cutoff ? null : p.cvd,
    }));
  };
}

let registered = false;

export function ensureFocusIndicatorsRegistered(): void {
  if (registered) return;

  registerIndicator<StructureDatum, number, StructureExtend>({
    name: STRUCTURE_INDICATOR,
    shortName: '',
    series: 'price',
    calcParams: [],
    figures: [],
    extendData: { priorDay: null },
    calc: makeStructureCalc({ intervalMs: 3_600_000 }),
    createTooltipDataSource: () => ({ name: '', calcParamsText: '', features: [], legends: [] }),
    draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
      const dataList = chart.getDataList();
      const results = indicator.result;
      const extend = indicator.extendData;

      ctx.save();

      // Prior-day levels: extendData.priorDay: { high, low, close } | null
      const priorDay = extend?.priorDay;
      if (priorDay) {
        const levels: Array<{ label: string; price: number }> = [
          { label: 'Prior-day high', price: priorDay.high },
          { label: 'Prior-day low', price: priorDay.low },
          { label: 'Prior-day close', price: priorDay.close },
        ];
        ctx.strokeStyle = FOCUS_COLORS.muted;
        ctx.lineWidth = 1;
        ctx.fillStyle = FOCUS_COLORS.muted;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        for (const { label, price } of levels) {
          if (typeof price === 'number' && Number.isFinite(price)) {
            const y = Math.round(yAxis.convertToPixel(price)) + 0.5;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(bounding.width, y);
            ctx.stroke();
            ctx.fillText(label, bounding.width - 4, y - 2);
          }
        }
      }

      // Draw pivot labels and structural break events
      for (let i = 0; i < dataList.length; i++) {
        const datum = results?.[i];
        if (!datum) continue;

        if (datum.pivotLabel) {
          const { label, kind } = datum.pivotLabel;
          const k = dataList[i];
          if (k) {
            const x = xAxis.convertToPixel(i);
            const color =
              label === 'HH' || label === 'HL'
                ? FOCUS_COLORS.bullish
                : FOCUS_COLORS.bearish;
            ctx.font = '10px sans-serif';
            ctx.fillStyle = color;
            ctx.textAlign = 'center';
            if (kind === 'high') {
              ctx.textBaseline = 'bottom';
              const y = yAxis.convertToPixel(k.high);
              ctx.fillText(label, x, y - 4);
            } else {
              ctx.textBaseline = 'top';
              const y = yAxis.convertToPixel(k.low);
              ctx.fillText(label, x, y + 4);
            }
          }
        }

        if (datum.events && datum.events.length > 0) {
          for (const ev of datum.events) {
            if (ev.pivotIndex < 0 || ev.pivotIndex >= dataList.length) continue;
            const x0 = xAxis.convertToPixel(ev.pivotIndex);
            const x1 = xAxis.convertToPixel(i);
            const y = Math.round(yAxis.convertToPixel(ev.level)) + 0.5;

            if (ev.internal) {
              ctx.strokeStyle = FOCUS_COLORS.muted;
              ctx.lineWidth = 1;
              ctx.setLineDash([2, 2]);
              ctx.beginPath();
              ctx.moveTo(x0, y);
              ctx.lineTo(x1, y);
              ctx.stroke();
              ctx.setLineDash([]);
            } else {
              const color = ev.latest
                ? FOCUS_COLORS.accent
                : ev.direction === 'bull'
                  ? FOCUS_COLORS.bullish
                  : FOCUS_COLORS.bearish;
              ctx.strokeStyle = color;
              ctx.lineWidth = 1.5;
              if (ev.type === 'CHoCH') {
                ctx.setLineDash([4, 4]);
              } else {
                ctx.setLineDash([]);
              }
              ctx.beginPath();
              ctx.moveTo(x0, y);
              ctx.lineTo(x1, y);
              ctx.stroke();
              ctx.setLineDash([]);

              const midX = (x0 + x1) / 2;
              ctx.font = '10px sans-serif';
              ctx.fillStyle = color;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'bottom';
              ctx.fillText(ev.type, midX, y - 2);
            }
          }
        }
      }

      // Draw lab-v4 marks: small hollow triangles at entry bars with S1 or S2 text
      const labMarks = extend?.labMarks;
      if (labMarks && Array.isArray(labMarks)) {
        const size = 6;
        const h = size * 0.9;
        const gap = 3;

        for (const mark of labMarks) {
          const idx = dataList.findIndex((k) => k.timestamp === mark.time);
          if (idx < 0 || idx >= dataList.length) continue;
          const k = dataList[idx];
          if (!k) continue;

          const x = xAxis.convertToPixel(idx);
          const isLong = mark.side === 1;
          const tipY = isLong
            ? yAxis.convertToPixel(k.low) + gap
            : yAxis.convertToPixel(k.high) - gap;
          const baseY = isLong ? tipY + h : tipY - h;

          ctx.strokeStyle = FOCUS_COLORS.accent;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, tipY);
          ctx.lineTo(x - size / 2, baseY);
          ctx.lineTo(x + size / 2, baseY);
          ctx.closePath();
          ctx.stroke();

          ctx.font = '9px sans-serif';
          ctx.fillStyle = FOCUS_COLORS.accent;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(mark.label, x + size / 2 + 2, (tipY + baseY) / 2);
        }
      }

      ctx.restore();
      return false;
    },
  });

  registerIndicator<DeltaVolDatum>({
    name: DELTA_VOL_INDICATOR,
    shortName: 'VOL',
    series: 'volume',
    calcParams: [],
    figures: [
      {
        key: 'volume',
        title: 'Vol: ',
        type: 'bar',
        baseValue: 0,
        styles: ({ data }) => {
          const winner = data.current?.winner;
          const color =
            winner === 'buy'
              ? FOCUS_COLORS.bullish
              : winner === 'sell'
                ? FOCUS_COLORS.bearish
                : FOCUS_COLORS.muted;
          return { style: 'fill', color, borderColor: color };
        },
      },
    ],
    calc: makeDeltaVolCalc(),
    createTooltipDataSource: ({ indicator, crosshair }) => {
      const index = crosshair?.dataIndex;
      const d = typeof index === 'number' ? indicator.result[index] : undefined;
      if (!d) {
        return { name: '', calcParamsText: '', features: [], legends: [] };
      }
      const volStr = formatFlow(d.volume);
      const deltaStr =
        d.delta === null || d.delta === undefined
          ? 'n/a'
          : formatFlow(d.delta, { signed: true });
      const deltaColor =
        d.winner === 'buy'
          ? FOCUS_COLORS.bullish
          : d.winner === 'sell'
            ? FOCUS_COLORS.bearish
            : FOCUS_COLORS.muted;
      return {
        name: '',
        calcParamsText: '',
        features: [],
        legends: [
          { title: '', value: { text: `Vol ${volStr}`, color: FOCUS_COLORS.muted } },
          { title: '', value: { text: `Delta ${deltaStr}`, color: deltaColor } },
        ],
      };
    },
  });

  registerIndicator<CvdDatum>({
    name: CVD_INDICATOR,
    shortName: 'CVD',
    series: 'normal',
    calcParams: [],
    figures: [
      {
        key: 'cvd',
        title: 'CVD: ',
        type: 'line',
        styles: () => ({
          color: FOCUS_COLORS.muted,
          size: 1.5,
        }),
      },
    ],
    calc: makeCvdCalc(),
    createTooltipDataSource: ({ indicator, crosshair }) => {
      const index = crosshair?.dataIndex;
      const d = typeof index === 'number' ? indicator.result[index] : undefined;
      if (!d) {
        return { name: '', calcParamsText: '', features: [], legends: [] };
      }
      const valStr =
        d.cvd === null || d.cvd === undefined ? 'n/a' : formatFlow(d.cvd);
      return {
        name: '',
        calcParamsText: '',
        features: [],
        legends: [
          {
            title: '',
            value: {
              text: `CVD (resets 00:00 UTC) ${valStr}`,
              color: FOCUS_COLORS.muted,
            },
          },
        ],
      };
    },
  });

  registered = true;
}
