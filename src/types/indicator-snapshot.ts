export interface IndicatorSnapshot {
  rsi: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  bollingerUpper: number | null;
  bollingerMiddle: number | null;
  bollingerLower: number | null;
  ema12: number | null;
  ema26: number | null;
  sma50: number | null;
  sma200: number | null;
  atr: number | null;
  stochRsiK: number | null;
  stochRsiD: number | null;
  williamsR: number | null;
  obv: number | null;
  mfi: number | null;
  superTrendDirection: 'up' | 'down' | null;
  fearGreedIndex: number | null;
  fearGreedLabel: string | null;
}
