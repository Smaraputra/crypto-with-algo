import type {
  FundingRate,
  OpenInterest,
  OpenInterestHist,
  LongShortRatio,
  GlobalLongShortRatio,
  FuturesData,
} from '@/types/futures';

export const mockFundingRate: FundingRate = {
  symbol: 'BTCUSDT',
  fundingRate: 0.0001,
  fundingTime: 1700000000000,
  markPrice: 43500.25,
};

export const mockNegativeFundingRate: FundingRate = {
  symbol: 'BTCUSDT',
  fundingRate: -0.0015,
  fundingTime: 1700000000000,
  markPrice: 41200.50,
};

export const mockHighFundingRate: FundingRate = {
  symbol: 'BTCUSDT',
  fundingRate: 0.0025,
  fundingTime: 1700000000000,
  markPrice: 48000.00,
};

export const mockFundingRateHistory: FundingRate[] = Array.from(
  { length: 10 },
  (_, i) => ({
    symbol: 'BTCUSDT',
    fundingRate: 0.0001 + (Math.sin(i) * 0.0005),
    fundingTime: 1700000000000 - i * 28800000, // 8 hours apart
    markPrice: 43000 + Math.random() * 2000,
  })
);

export const mockOpenInterest: OpenInterest = {
  symbol: 'BTCUSDT',
  openInterest: 123456.789,
  time: 1700000000000,
};

export const mockOpenInterestHistory: OpenInterestHist[] = Array.from(
  { length: 20 },
  (_, i) => ({
    symbol: 'BTCUSDT',
    sumOpenInterest: 120000 + i * 500,
    sumOpenInterestValue: 5200000000 + i * 20000000,
    timestamp: 1700000000000 - i * 300000, // 5 minutes apart
  })
);

export const mockLongShortRatio: LongShortRatio = {
  symbol: 'BTCUSDT',
  longShortRatio: 1.23,
  longAccount: 0.5525,
  shortAccount: 0.4475,
  timestamp: 1700000000000,
};

export const mockHeavilyLong: LongShortRatio = {
  symbol: 'BTCUSDT',
  longShortRatio: 2.1,
  longAccount: 0.677,
  shortAccount: 0.323,
  timestamp: 1700000000000,
};

export const mockHeavilyShort: LongShortRatio = {
  symbol: 'BTCUSDT',
  longShortRatio: 0.55,
  longAccount: 0.355,
  shortAccount: 0.645,
  timestamp: 1700000000000,
};

export const mockGlobalLongShortRatio: GlobalLongShortRatio = {
  symbol: 'BTCUSDT',
  longShortRatio: 1.15,
  longAccount: 0.535,
  shortAccount: 0.465,
  timestamp: 1700000000000,
};

export const mockFuturesData: FuturesData = {
  fundingRate: mockFundingRate,
  openInterest: mockOpenInterest,
  longShortRatio: mockLongShortRatio,
};

export const mockFuturesDataPartial: FuturesData = {
  fundingRate: mockFundingRate,
  openInterest: null,
  longShortRatio: null,
};

export const mockFuturesDataEmpty: FuturesData = {
  fundingRate: null,
  openInterest: null,
  longShortRatio: null,
};
