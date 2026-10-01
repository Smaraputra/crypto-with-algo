export interface FundingRate {
  symbol: string;
  fundingRate: number;
  fundingTime: number;
  markPrice: number;
}

export interface OpenInterest {
  symbol: string;
  openInterest: number;
  time: number;
}

export interface OpenInterestHist {
  symbol: string;
  sumOpenInterest: number;
  sumOpenInterestValue: number;
  timestamp: number;
}

export interface LongShortRatio {
  symbol: string;
  longShortRatio: number;
  longAccount: number;
  shortAccount: number;
  timestamp: number;
  /**
   * The ratio's trailing 30-day z-score WITHIN this symbol, on the 1h snapshot
   * grid (`buildSnapshotSeries`). The scorer reads this, not the raw level,
   * since configVersion 8: the level's centre sits near 1.5 and drifts by more
   * than any fixed band is wide. Absent or null when there is not enough
   * history, and then the signal abstains.
   */
  zScore?: number | null;
}

export interface GlobalLongShortRatio {
  symbol: string;
  longShortRatio: number;
  longAccount: number;
  shortAccount: number;
  timestamp: number;
}

export interface FuturesData {
  fundingRate: FundingRate | null;
  openInterest: OpenInterest | null;
  longShortRatio: LongShortRatio | null;
}
