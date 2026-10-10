import { registerIndicator, type KLineData } from 'klinecharts';

import type { CallMark } from '@/lib/signals/track-record/chart-data';
import { tierDisplayLabel } from '@/lib/signals/tier-labels';

/**
 * Past calls on the price pane: a triangle under the bar for a buy call and
 * over it for a sell call, coloured by how the call ended (won after costs,
 * right but eaten by costs, wrong, or still pending). A dashed vertical line
 * marks where the re-scored year hands over to the live record, and the call
 * under the crosshair draws the span it was judged on: its close to the close
 * horizonBars later.
 */

export const SIGNAL_CALLS_INDICATOR = 'SIGNAL_CALLS';

export const CALL_COLORS = {
  won: '#0ecb81',
  cost: '#848e9c',
  wrong: '#f6465d',
  pending: '#b7bdc6',
} as const;
const BOUNDARY_LINE = '#848e9c';
const BOUNDARY_TEXT = '#b7bdc6';

export interface CallsSnapshot {
  calls: ReadonlyMap<number, CallMark>;
  horizonBars: number;
  costPercent: number;
}

/** Redraw-only state: changing it repaints without recalculating. */
export interface CallsExtend {
  boundary: number | null;
  /** Open time of the call under the crosshair. */
  hover: number | null;
  /** Bars from a call's close to the close it was judged on. */
  horizonBars: number;
}

export interface CallsDatum {
  call?: CallMark;
  tip?: string;
}

const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

export function describeCall(call: CallMark, horizonBars: number, costPercent: number): string {
  const side = call.dir === 1 ? 'Buy call' : 'Sell call';
  const source = call.source === 'live' ? 'live record' : 're-scored, not live';
  const head = `${side} (${tierDisplayLabel(call.tier)}) · ${source} · score ${call.score.toFixed(1)}`;
  if (call.fwd === null) return `${head} · outcome pending`;
  const directional = call.dir * call.fwd;
  const verdict =
    call.outcome === 'won' ? 'won after costs' : call.outcome === 'cost' ? 'right, but costs ate it' : 'wrong way';
  return `${head} · price ${pct(call.fwd)} over ${horizonBars} bars · ${pct(directional - costPercent)} after ${costPercent.toFixed(2)}% costs · ${verdict}`;
}

/** A NEW function every call, so overrideIndicator recalculates (see signal-score-indicator). */
export function makeSignalCallsCalc(snapshot: CallsSnapshot) {
  const { calls, horizonBars, costPercent } = snapshot;
  return (dataList: KLineData[]): CallsDatum[] =>
    dataList.map((k) => {
      const call = calls.get(k.timestamp);
      return call ? { call, tip: describeCall(call, horizonBars, costPercent) } : {};
    });
}

function triangle(ctx: CanvasRenderingContext2D, x: number, tipY: number, size: number, pointsUp: boolean) {
  const h = size * 0.9;
  const baseY = pointsUp ? tipY + h : tipY - h;
  ctx.beginPath();
  ctx.moveTo(x, tipY);
  ctx.lineTo(x - size / 2, baseY);
  ctx.lineTo(x + size / 2, baseY);
  ctx.closePath();
}

let registered = false;

export function ensureSignalCallsIndicatorRegistered(): void {
  if (registered) return;
  registerIndicator<CallsDatum, number, CallsExtend>({
    name: SIGNAL_CALLS_INDICATOR,
    shortName: '',
    series: 'price',
    calcParams: [],
    figures: [],
    extendData: { boundary: null, hover: null, horizonBars: 0 },
    calc: makeSignalCallsCalc({ calls: new Map(), horizonBars: 0, costPercent: 0 }),
    createTooltipDataSource: ({ indicator, crosshair }) => {
      const index = crosshair.dataIndex;
      const datum = typeof index === 'number' ? indicator.result[index] : undefined;
      return {
        name: '',
        calcParamsText: '',
        features: [],
        legends: datum?.tip
          ? [{ title: '', value: { text: datum.tip, color: datum.call ? CALL_COLORS[datum.call.outcome] : BOUNDARY_TEXT } }]
          : [],
      };
    },
    draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
      const dataList = chart.getDataList();
      const results = indicator.result;
      const { from, to } = chart.getVisibleRange();
      const barSpace = chart.getBarSpace().bar;
      const size = Math.max(4, Math.min(9, barSpace * 0.9));
      const gap = 3;
      const extend = indicator.extendData;

      ctx.save();
      // Hand-over line: left of it the re-score, right of it the live record.
      const boundary = extend?.boundary ?? null;
      if (boundary !== null && dataList.length > 0 && boundary >= dataList[0].timestamp && boundary <= dataList[dataList.length - 1].timestamp) {
        const x = Math.round(xAxis.convertTimestampToPixel(boundary) - barSpace / 2) + 0.5;
        if (x >= 0 && x <= bounding.width) {
          ctx.strokeStyle = BOUNDARY_LINE;
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, bounding.height);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = '11px sans-serif';
          ctx.fillStyle = BOUNDARY_TEXT;
          ctx.textBaseline = 'bottom';
          ctx.textAlign = 'right';
          ctx.fillText('re-scored', x - 4, bounding.height - 4);
          ctx.textAlign = 'left';
          ctx.fillText('live record', x + 4, bounding.height - 4);
        }
      }

      for (let i = Math.max(0, from); i < Math.min(to, dataList.length); i++) {
        const call = results[i]?.call;
        if (!call) continue;
        const k = dataList[i];
        const x = xAxis.convertToPixel(i);
        const color = CALL_COLORS[call.outcome];
        if (call.dir === 1) triangle(ctx, x, yAxis.convertToPixel(k.low) + gap, size, true);
        else triangle(ctx, x, yAxis.convertToPixel(k.high) - gap, size, false);
        if (call.outcome === 'pending') {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.stroke();
        } else {
          ctx.fillStyle = color;
          ctx.fill();
        }
      }

      // The span the hovered call was judged on.
      const hover = extend?.hover ?? null;
      if (hover !== null) {
        const i = dataList.findIndex((k) => k.timestamp === hover);
        const call = i >= 0 ? results[i]?.call : undefined;
        const horizon = extend?.horizonBars ?? 0;
        const j = i + horizon;
        if (call && horizon > 0 && j < dataList.length) {
          const x0 = xAxis.convertToPixel(i);
          const y0 = yAxis.convertToPixel(dataList[i].close);
          const x1 = xAxis.convertToPixel(j);
          const y1 = yAxis.convertToPixel(dataList[j].close);
          const color = CALL_COLORS[call.outcome];
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
          for (const [x, y] of [
            [x0, y0],
            [x1, y1],
          ]) {
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
          }
          if (call.fwd !== null) {
            ctx.font = '11px sans-serif';
            ctx.textBaseline = 'bottom';
            ctx.textAlign = 'left';
            ctx.fillText(pct(call.fwd), x1 + 5, y1 - 3);
          }
        }
      }
      ctx.restore();
      return false;
    },
  });
  registered = true;
}
