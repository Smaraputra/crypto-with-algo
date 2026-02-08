export interface SnapshotHolding {
  symbol: string;
  quantity: number;
  price: number;
  value: number;
}

export interface PortfolioSnapshot {
  _id: string;
  userId: string;
  portfolioId: string;
  date: Date;
  totalValue: number;
  totalCost: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  holdings: SnapshotHolding[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PortfolioHistoryPoint {
  date: string;
  totalValue: number;
  totalCost: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

export interface TaxLot {
  date: Date;
  quantity: number;
  pricePerUnit: number;
  fee: number;
  remainingQuantity: number;
}

export interface RealizedGain {
  sellDate: Date;
  buyDate: Date;
  quantity: number;
  proceeds: number;
  costBasis: number;
  gain: number;
  holdingPeriod: 'short-term' | 'long-term';
  symbol: string;
}

export interface CostBasisHolding {
  symbol: string;
  totalQuantity: number;
  averageCost: number;
  totalCost: number;
  openLots: TaxLot[];
  realizedGains: RealizedGain[];
  totalRealizedGain: number;
}

export type CostBasisMethod = 'fifo' | 'lifo' | 'hifo';
export type CsvFormat = 'generic' | 'koinly' | 'cointracker';

export interface CostBasisResult {
  holdings: CostBasisHolding[];
  totalRealizedGain: number;
  totalUnrealizedCostBasis: number;
  method: CostBasisMethod;
}

export interface RiskMetrics {
  annualizedVolatility: number | null;
  maxDrawdown: number | null;
  maxDrawdownDate: string | null;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  bestDay: { date: string; return: number } | null;
  worstDay: { date: string; return: number } | null;
  annualizedReturn: number | null;
  totalReturn: number | null;
  dataPoints: number;
}

export interface PortfolioHistoryResponse {
  history: PortfolioHistoryPoint[];
}

export interface CostBasisResponse {
  costBasis: CostBasisResult;
}

export interface RiskMetricsResponse {
  metrics: RiskMetrics | null;
  insufficientData: boolean;
  dataPoints: number;
  minRequired: number;
}
