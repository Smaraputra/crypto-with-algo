import type {
  PortfolioSnapshot,
  PortfolioHistoryPoint,
  CostBasisResult,
  CostBasisHolding,
  RiskMetrics,
  TaxLot,
  RealizedGain,
} from '@/types/analytics';

export const mockSnapshotHoldings = [
  { symbol: 'BTCUSDT', quantity: 0.5, price: 42000, value: 21000 },
  { symbol: 'ETHUSDT', quantity: 2.0, price: 2500, value: 5000 },
];

export const mockSnapshot: PortfolioSnapshot = {
  _id: 'snap-1',
  userId: 'user-1',
  portfolioId: 'portfolio-1',
  date: new Date('2024-01-15T00:00:00.000Z'),
  totalValue: 26000,
  totalCost: 25010,
  unrealizedPnl: 990,
  unrealizedPnlPercent: 3.96,
  holdings: mockSnapshotHoldings,
  createdAt: new Date('2024-01-15T00:00:00.000Z'),
  updatedAt: new Date('2024-01-15T00:00:00.000Z'),
};

export const mockSnapshotSeries: PortfolioSnapshot[] = Array.from(
  { length: 30 },
  (_, i) => {
    const date = new Date('2024-01-01T00:00:00.000Z');
    date.setUTCDate(date.getUTCDate() + i);
    const baseValue = 25000;
    const dailyChange = (Math.sin(i * 0.5) * 1000) + (i * 50);
    const totalValue = baseValue + dailyChange;
    const totalCost = 25010;
    return {
      _id: `snap-${i + 1}`,
      userId: 'user-1',
      portfolioId: 'portfolio-1',
      date,
      totalValue,
      totalCost,
      unrealizedPnl: totalValue - totalCost,
      unrealizedPnlPercent: ((totalValue - totalCost) / totalCost) * 100,
      holdings: mockSnapshotHoldings,
      createdAt: date,
      updatedAt: date,
    };
  }
);

export const mockHistoryPoints: PortfolioHistoryPoint[] =
  mockSnapshotSeries.map((s) => ({
    date: s.date.toISOString(),
    totalValue: s.totalValue,
    totalCost: s.totalCost,
    unrealizedPnl: s.unrealizedPnl,
    unrealizedPnlPercent: s.unrealizedPnlPercent,
  }));

export const mockOpenLot: TaxLot = {
  date: new Date('2024-01-15'),
  quantity: 0.5,
  pricePerUnit: 40000,
  fee: 10,
  remainingQuantity: 0.3,
};

export const mockRealizedGain: RealizedGain = {
  sellDate: new Date('2024-06-15'),
  buyDate: new Date('2024-01-15'),
  quantity: 0.2,
  proceeds: 13000,
  costBasis: 8004,
  gain: 4996,
  holdingPeriod: 'long-term',
  symbol: 'BTCUSDT',
};

export const mockCostBasisHolding: CostBasisHolding = {
  symbol: 'BTCUSDT',
  totalQuantity: 0.3,
  averageCost: 40020,
  totalCost: 12006,
  openLots: [mockOpenLot],
  realizedGains: [mockRealizedGain],
  totalRealizedGain: 4996,
};

export const mockCostBasisResult: CostBasisResult = {
  holdings: [mockCostBasisHolding],
  totalRealizedGain: 4996,
  totalUnrealizedCostBasis: 12006,
};

export const mockRiskMetrics: RiskMetrics = {
  annualizedVolatility: 0.42,
  maxDrawdown: -0.15,
  maxDrawdownDate: '2024-01-20',
  sharpeRatio: 1.8,
  sortinoRatio: 2.3,
  bestDay: { date: '2024-01-10', return: 0.08 },
  worstDay: { date: '2024-01-20', return: -0.06 },
  annualizedReturn: 0.85,
  totalReturn: 0.12,
  dataPoints: 30,
};

export const mockInsufficientRiskMetrics: RiskMetrics = {
  annualizedVolatility: null,
  maxDrawdown: null,
  maxDrawdownDate: null,
  sharpeRatio: null,
  sortinoRatio: null,
  bestDay: null,
  worstDay: null,
  annualizedReturn: null,
  totalReturn: null,
  dataPoints: 3,
};
