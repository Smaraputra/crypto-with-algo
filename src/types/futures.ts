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
