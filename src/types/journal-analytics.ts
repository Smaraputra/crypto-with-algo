/**
 * `winRate: number | null` throughout, and null means "not enough closed trades
 * to state a rate" rather than zero.
 *
 * It used to be a plain number that the route set to 0 for an empty sample, so
 * a user with no closed trades read `Win Rate 0.0%` -- which says "you lost"
 * rather than "no data" -- while the PnL strip beside it correctly showed a
 * dash for the same dataset. The per-breakdown rates had the same problem one
 * step further on: with one closed trade a panel rendered `1 trades - 100%`
 * under a heading like "By Hour (UTC)", presenting an hour-of-day edge from a
 * single observation. See ANALYTICS_MIN_SAMPLE_FOR_RATE in the route.
 *
 * KellySuggestion.winRate stays a number: it is only read when `reliable` is
 * true, which already requires 20 closed trades.
 */
export interface JournalAnalyticsSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
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
  winRate: number | null;
  avgPnlPercent: number | null;
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
  winRate: number | null;
  avgPnlPercent: number | null;
}

export interface MarketConditionPerformance {
  condition: string;
  count: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgPnlPercent: number | null;
}

export interface MonthlyPnl {
  month: string; // YYYY-MM
  pnlPercent: number;
  tradeCount: number;
}

export interface SignalTierAccuracy {
  tier: string;
  count: number;
  avgPnlPercent: number | null;
  winRate: number | null;
}

export interface SessionPerformance {
  session: string; // MarketSession, UTC buckets
  count: number;
  wins: number;
  winRate: number | null;
  avgPnlPercent: number | null;
}

export interface HourPerformance {
  hour: number; // 0-23 UTC
  count: number;
  wins: number;
  winRate: number | null;
  avgPnlPercent: number | null;
}

export interface WeekdayPerformance {
  weekday: number; // 0 = Sunday .. 6 = Saturday, UTC
  count: number;
  wins: number;
  winRate: number | null;
  avgPnlPercent: number | null;
}

export interface EmotionPerformance {
  emotion: string; // TradeEmotion
  count: number;
  wins: number;
  winRate: number | null;
  avgPnlPercent: number | null;
}

export interface MistakePerformance {
  mistake: string; // TradeMistake
  count: number;
  avgPnlPercent: number | null; // average outcome of trades carrying this mistake
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
