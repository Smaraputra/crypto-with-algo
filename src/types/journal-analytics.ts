export interface JournalAnalyticsSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnlPercent: number;
  bestTrade: number | null;
  worstTrade: number | null;
  totalPnlPercent: number;
  profitFactor: number | null;
}

export interface TagPerformance {
  tag: string;
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnlPercent: number;
}

export interface ActionDistribution {
  action: string;
  count: number;
  percentage: number;
}

export interface SetupPerformance {
  setupType: string;
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnlPercent: number;
}

export interface MarketConditionPerformance {
  condition: string;
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnlPercent: number;
}

export interface MonthlyPnl {
  month: string; // YYYY-MM
  pnlPercent: number;
  tradeCount: number;
}

export interface SignalTierAccuracy {
  tier: string;
  count: number;
  avgPnlPercent: number;
  winRate: number;
}

export interface JournalAnalyticsResponse {
  summary: JournalAnalyticsSummary;
  byTag: TagPerformance[];
  byAction: ActionDistribution[];
  bySetupType: SetupPerformance[];
  byMarketCondition: MarketConditionPerformance[];
  byMonth: MonthlyPnl[];
  bySignalTier: SignalTierAccuracy[];
}
