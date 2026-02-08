export interface IndicatorParamDef {
  label: string;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
}

export interface IndicatorParamsMeta {
  id: string;
  params: IndicatorParamDef[];
}

export const INDICATOR_PARAMS: Record<string, IndicatorParamDef[]> = {
  MA: [
    { label: 'Period 1', defaultValue: 5, min: 1, max: 200, step: 1 },
    { label: 'Period 2', defaultValue: 10, min: 1, max: 200, step: 1 },
    { label: 'Period 3', defaultValue: 30, min: 1, max: 200, step: 1 },
    { label: 'Period 4', defaultValue: 60, min: 1, max: 200, step: 1 },
  ],
  EMA: [
    { label: 'Period 1', defaultValue: 6, min: 1, max: 200, step: 1 },
    { label: 'Period 2', defaultValue: 12, min: 1, max: 200, step: 1 },
    { label: 'Period 3', defaultValue: 20, min: 1, max: 200, step: 1 },
  ],
  BOLL: [
    { label: 'Period', defaultValue: 20, min: 1, max: 200, step: 1 },
    { label: 'Std Dev', defaultValue: 2, min: 1, max: 10, step: 1 },
  ],
  SAR: [
    { label: 'Accel Factor', defaultValue: 2, min: 1, max: 10, step: 1 },
    { label: 'Accel Incr', defaultValue: 2, min: 1, max: 10, step: 1 },
    { label: 'Max Accel', defaultValue: 20, min: 1, max: 100, step: 1 },
  ],
  MACD: [
    { label: 'Fast', defaultValue: 12, min: 1, max: 100, step: 1 },
    { label: 'Slow', defaultValue: 26, min: 1, max: 100, step: 1 },
    { label: 'Signal', defaultValue: 9, min: 1, max: 100, step: 1 },
  ],
  RSI: [
    { label: 'Period 1', defaultValue: 6, min: 1, max: 100, step: 1 },
    { label: 'Period 2', defaultValue: 12, min: 1, max: 100, step: 1 },
    { label: 'Period 3', defaultValue: 24, min: 1, max: 100, step: 1 },
  ],
  KDJ: [
    { label: 'K Period', defaultValue: 9, min: 1, max: 100, step: 1 },
    { label: 'D Period', defaultValue: 3, min: 1, max: 100, step: 1 },
    { label: 'J Period', defaultValue: 3, min: 1, max: 100, step: 1 },
  ],
  VOL: [
    { label: 'Period 1', defaultValue: 5, min: 1, max: 200, step: 1 },
    { label: 'Period 2', defaultValue: 10, min: 1, max: 200, step: 1 },
    { label: 'Period 3', defaultValue: 20, min: 1, max: 200, step: 1 },
  ],
  OBV: [
    { label: 'Period', defaultValue: 30, min: 1, max: 200, step: 1 },
  ],
};

export function getDefaultCalcParams(indicatorId: string): number[] {
  const params = INDICATOR_PARAMS[indicatorId];
  if (!params) return [];
  return params.map((p) => p.defaultValue);
}
