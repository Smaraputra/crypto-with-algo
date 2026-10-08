import { registerIndicator, type KLineData } from 'klinecharts';

import { TIER_BUY_CUTOFF, TIER_STRONG_CUTOFF } from '@/lib/signals/calibration';
import { tierDisplayLabel } from '@/lib/signals/tier-labels';
import type { ProvisionalScore } from '@/lib/signals/provisional/types';
import type { SignalTier } from '@/types/signal';

export const SIGNAL_SCORE_INDICATOR = 'SIGNAL_SCORE';
export const SIGNAL_SCORE_PANE_ID = 'signal_score_pane';

const BULLISH = '#0ecb81';
const BEARISH = '#f6465d';
const ACCENT = '#f0b90b';
const NEUTRAL = '#71717a';
const GUIDE = '#474d57';
const GUIDE_LEVELS = [TIER_BUY_CUTOFF, TIER_STRONG_CUTOFF, -TIER_BUY_CUTOFF, -TIER_STRONG_CUTOFF];

export interface RecordedScore {
  score: number;
  tier: SignalTier;
  confidence: number;
  configVersion: number;
}

export type OverlayState = 'provisional' | 'awaiting-record' | null;

export interface SignalScoreSnapshot {
  recorded: ReadonlyMap<number, RecordedScore>;
  provisional: ProvisionalScore | null;
  state: OverlayState;
}

/** One row per kline. `tip` feeds the tooltip and is not a figure. */
export interface SignalScoreDatum {
  recorded?: number;
  provisional?: number;
  tip?: string;
}

/**
 * A NEW function every call: overrideIndicator recalculates only when `calc`
 * changes identity, so passing a fresh one is what makes data updates repaint.
 */
export function makeSignalScoreCalc(snapshot: SignalScoreSnapshot) {
  const { recorded, provisional, state } = snapshot;
  return (dataList: KLineData[]): SignalScoreDatum[] =>
    dataList.map((k) => {
      const rec = recorded.get(k.timestamp);
      if (rec) {
        return {
          recorded: rec.score,
          tip: `Recorded ${rec.score.toFixed(1)} · ${tierDisplayLabel(rec.tier)} · ${Math.round(rec.confidence)}% data coverage · configVersion ${rec.configVersion}`,
        };
      }
      if (provisional && state && k.timestamp === provisional.openTime) {
        return {
          provisional: provisional.score,
          tip:
            state === 'awaiting-record'
              ? 'Closed · awaiting the recorded score'
              : `Provisional ${provisional.score.toFixed(1)} · ${tierDisplayLabel(provisional.tier)} · repaints until the bar closes, never recorded`,
        };
      }
      return {};
    });
}

let registered = false;

export function ensureSignalScoreIndicatorRegistered(): void {
  if (registered) return;
  registerIndicator<SignalScoreDatum>({
    name: SIGNAL_SCORE_INDICATOR,
    shortName: 'SIGNAL SCORE',
    series: 'normal',
    precision: 1,
    minValue: -100,
    maxValue: 100,
    calcParams: [],
    shouldOhlc: false,
    figures: [
      {
        key: 'recorded',
        title: 'Recorded: ',
        type: 'bar',
        baseValue: 0,
        styles: ({ data }) => {
          const v = data.current?.recorded;
          const color =
            typeof v === 'number' && v >= TIER_BUY_CUTOFF
              ? BULLISH
              : typeof v === 'number' && v <= -TIER_BUY_CUTOFF
                ? BEARISH
                : NEUTRAL;
          return { style: 'fill', color, borderColor: color };
        },
      },
      {
        key: 'provisional',
        title: 'Provisional: ',
        type: 'bar',
        baseValue: 0,
        styles: () => ({
          style: 'stroke',
          color: ACCENT,
          borderColor: ACCENT,
          borderSize: 1,
          borderStyle: 'dashed',
          borderDashedValue: [3, 3],
        }),
      },
    ],
    calc: makeSignalScoreCalc({ recorded: new Map(), provisional: null, state: null }),
    createTooltipDataSource: ({ indicator, crosshair }) => {
      const index = crosshair.dataIndex;
      const tip = typeof index === 'number' ? indicator.result[index]?.tip : undefined;
      return {
        name: '',
        calcParamsText: '',
        features: [],
        legends: tip ? [{ title: '', value: { text: tip, color: ACCENT } }] : [],
      };
    },
    draw: ({ ctx, bounding, yAxis }) => {
      ctx.strokeStyle = GUIDE;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      for (const level of GUIDE_LEVELS) {
        const y = Math.round(yAxis.convertToPixel(level)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(bounding.width, y);
        ctx.stroke();
      }
      return false;
    },
  });
  registered = true;
}
