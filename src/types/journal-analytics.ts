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

export interface SessionPerformance {
  session: string; // MarketSession, UTC buckets
  count: number;
  wins: number;
  winRate: number;
  avgPnlPercent: number;
}

export interface HourPerformance {
  hour: number; // 0-23 UTC
  count: number;
  wins: number;
  winRate: number;
  avgPnlPercent: number;
}

export interface WeekdayPerformance {
  weekday: number; // 0 = Sunday .. 6 = Saturday, UTC
  count: number;
  wins: number;
  winRate: number;
  avgPnlPercent: number;
}

export interface EmotionPerformance {
  emotion: string; // TradeEmotion
  count: number;
  wins: number;
  winRate: number;
  avgPnlPercent: number;
}

export interface MistakePerformance {
  mistake: string; // TradeMistake
  count: number;
  avgPnlPercent: number; // average outcome of trades carrying this mistake
  totalPnlPercent: number; // cumulative cost
}

export interface TradeStreaks {
  current: { type: 'win' | 'loss'; length: number } | null;
  maxWinStreak: number;
  maxLossStreak: number;
}

export interface KellySuggestion {
  fraction: number; // full Kelly, 0-1 of equity (clamped at 0)
  halfFraction: number; // half Kelly, the practical suggestion
  winRate: number; // 0-1
  avgWinPercent: number;
  avgLossPercent: number; // positive magnitude
  sampleSize: number;
  reliable: boolean; // >= 20 closed trades with both wins and losses
}

export interface JournalAnalyticsResponse {
  summary: JournalAnalyticsSummary;
  incompleteTradeCount: number;
  byTag: TagPerformance[];
  byAction: ActionDistribution[];
  bySetupType: SetupPerformance[];
  byMarketCondition: MarketConditionPerformance[];
  byMonth: MonthlyPnl[];
  bySignalTier: SignalTierAccuracy[];
  bySession: SessionPerformance[];
  byHour: HourPerformance[];
  byWeekday: WeekdayPerformance[];
  byEmotion: EmotionPerformance[];
  byMistake: MistakePerformance[];
  streaks: TradeStreaks;
  kellySuggestion: KellySuggestion;
}
