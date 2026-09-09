import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { JournalEntry } from '@/lib/models/journal-entry';
import { SESSION_UTC_RANGES } from '@/lib/sessions';
import type {
  JournalAnalyticsSummary,
  TagPerformance,
  ActionDistribution,
  SetupPerformance,
  MarketConditionPerformance,
  MonthlyPnl,
  SignalTierAccuracy,
  SessionPerformance,
  HourPerformance,
  WeekdayPerformance,
  EmotionPerformance,
  MistakePerformance,
  TradeStreaks,
  KellySuggestion,
} from '@/types/journal-analytics';

// Session bucket from the entry's UTC hour, built from the shared taxonomy so
// the TS constants and the Mongo expression cannot drift
const SESSION_SWITCH_EXPR = {
  $switch: {
    branches: SESSION_UTC_RANGES.map((range) => ({
      case: {
        $and: [
          { $gte: [{ $hour: '$createdAt' }, range.startHour] },
          { $lt: [{ $hour: '$createdAt' }, range.endHour] },
        ],
      },
      then: range.session,
    })),
    default: 'off_hours',
  },
};

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const userId = session.user.id;
  const baseMatch = { userId };

  // Entries with a P&L outcome (both entry and exit price set)
  const pnlMatch = { userId, outcomePnlPercent: { $ne: null } };

  // Entries with entryPrice but no outcomePnlPercent (incomplete trades)
  const incompleteMatch = {
    userId,
    entryPrice: { $ne: null },
    outcomePnlPercent: null,
  };

  const [
    allEntries,
    pnlEntries,
    incompleteTradeCount,
    tagAgg,
    actionAgg,
    setupAgg,
    conditionAgg,
    monthlyAgg,
    tierAgg,
    sessionAgg,
    hourAgg,
    weekdayAgg,
    emotionAgg,
    mistakeAgg,
  ] = await Promise.all([
    // Total count
    JournalEntry.countDocuments(baseMatch),

    // All entries with P&L for summary computation (chronological for streaks)
    JournalEntry.find(pnlMatch, {
      outcomePnlPercent: 1,
      action: 1,
      createdAt: 1,
    })
      .sort({ createdAt: 1 })
      .lean(),

    // Incomplete trades (have entry price but no P&L)
    JournalEntry.countDocuments(incompleteMatch),

    // By tag
    JournalEntry.aggregate([
      { $match: { ...pnlMatch, tags: { $exists: true, $ne: [] } } },
      { $unwind: '$tags' },
      {
        $group: {
          _id: '$tags',
          count: { $sum: 1 },
          wins: { $sum: { $cond: [{ $gt: ['$outcomePnlPercent', 0] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $lt: ['$outcomePnlPercent', 0] }, 1, 0] } },
          totalPnl: { $sum: '$outcomePnlPercent' },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 50 },
    ]),

    // By action
    JournalEntry.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: '$action',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]),

    // By setup type
    JournalEntry.aggregate([
      { $match: { ...pnlMatch, setupType: { $ne: '' } } },
      {
        $group: {
          _id: '$setupType',
          count: { $sum: 1 },
          wins: { $sum: { $cond: [{ $gt: ['$outcomePnlPercent', 0] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $lt: ['$outcomePnlPercent', 0] }, 1, 0] } },
          totalPnl: { $sum: '$outcomePnlPercent' },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]),

    // By market condition
    JournalEntry.aggregate([
      { $match: { ...pnlMatch, marketCondition: { $ne: null } } },
      {
        $group: {
          _id: '$marketCondition',
          count: { $sum: 1 },
          wins: { $sum: { $cond: [{ $gt: ['$outcomePnlPercent', 0] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $lt: ['$outcomePnlPercent', 0] }, 1, 0] } },
          totalPnl: { $sum: '$outcomePnlPercent' },
        },
      },
      { $sort: { count: -1 } },
    ]),

    // By month
    JournalEntry.aggregate([
      { $match: pnlMatch },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m', date: '$createdAt' },
          },
          pnlPercent: { $sum: '$outcomePnlPercent' },
          tradeCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    // By signal tier
    JournalEntry.aggregate([
      { $match: pnlMatch },
      {
        $group: {
          _id: '$signalTier',
          count: { $sum: 1 },
          totalPnl: { $sum: '$outcomePnlPercent' },
          wins: { $sum: { $cond: [{ $gt: ['$outcomePnlPercent', 0] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    // By market session (UTC)
    JournalEntry.aggregate([
      { $match: pnlMatch },
      {
        $group: {
          _id: SESSION_SWITCH_EXPR,
          count: { $sum: 1 },
          wins: { $sum: { $cond: [{ $gt: ['$outcomePnlPercent', 0] }, 1, 0] } },
          totalPnl: { $sum: '$outcomePnlPercent' },
        },
      },
    ]),

    // By hour of day (UTC)
    JournalEntry.aggregate([
      { $match: pnlMatch },
      {
        $group: {
          _id: { $hour: '$createdAt' },
          count: { $sum: 1 },
          wins: { $sum: { $cond: [{ $gt: ['$outcomePnlPercent', 0] }, 1, 0] } },
          totalPnl: { $sum: '$outcomePnlPercent' },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    // By weekday (UTC; $dayOfWeek is 1 = Sunday .. 7 = Saturday)
    JournalEntry.aggregate([
      { $match: pnlMatch },
      {
        $group: {
          _id: { $dayOfWeek: '$createdAt' },
          count: { $sum: 1 },
          wins: { $sum: { $cond: [{ $gt: ['$outcomePnlPercent', 0] }, 1, 0] } },
          totalPnl: { $sum: '$outcomePnlPercent' },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    // By emotion
    JournalEntry.aggregate([
      { $match: { ...pnlMatch, emotion: { $ne: null } } },
      {
        $group: {
          _id: '$emotion',
          count: { $sum: 1 },
          wins: { $sum: { $cond: [{ $gt: ['$outcomePnlPercent', 0] }, 1, 0] } },
          totalPnl: { $sum: '$outcomePnlPercent' },
        },
      },
      { $sort: { count: -1 } },
    ]),

    // By mistake (a trade can carry several)
    JournalEntry.aggregate([
      { $match: { ...pnlMatch, mistakes: { $exists: true, $ne: [] } } },
      { $unwind: '$mistakes' },
      {
        $group: {
          _id: '$mistakes',
          count: { $sum: 1 },
          totalPnl: { $sum: '$outcomePnlPercent' },
        },
      },
      { $sort: { count: -1 } },
    ]),
  ]);

  // Compute summary
  const wins = pnlEntries.filter((e) => (e.outcomePnlPercent ?? 0) > 0).length;
  const losses = pnlEntries.filter((e) => (e.outcomePnlPercent ?? 0) < 0).length;
  const pnlValues = pnlEntries.map((e) => e.outcomePnlPercent as number);
  const totalPnl = pnlValues.reduce((sum, v) => sum + v, 0);
  const avgPnl = pnlValues.length > 0 ? totalPnl / pnlValues.length : 0;
  const bestTrade = pnlValues.length > 0 ? Math.max(...pnlValues) : null;
  const worstTrade = pnlValues.length > 0 ? Math.min(...pnlValues) : null;

  const grossProfit = pnlValues.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const grossLoss = Math.abs(pnlValues.filter((v) => v < 0).reduce((s, v) => s + v, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  const summary: JournalAnalyticsSummary = {
    totalTrades: allEntries,
    wins,
    losses,
    winRate: pnlValues.length > 0 ? (wins / pnlValues.length) * 100 : 0,
    avgPnlPercent: avgPnl,
    bestTrade,
    worstTrade,
    totalPnlPercent: totalPnl,
    profitFactor,
  };

  const byTag: TagPerformance[] = tagAgg.map((t) => ({
    tag: t._id as string,
    count: t.count as number,
    wins: t.wins as number,
    losses: t.losses as number,
    winRate: t.count > 0 ? ((t.wins as number) / (t.count as number)) * 100 : 0,
    avgPnlPercent: t.count > 0 ? (t.totalPnl as number) / (t.count as number) : 0,
  }));

  const byAction: ActionDistribution[] = actionAgg.map((a) => ({
    action: a._id as string,
    count: a.count as number,
    percentage: allEntries > 0 ? ((a.count as number) / allEntries) * 100 : 0,
  }));

  const bySetupType: SetupPerformance[] = setupAgg.map((s) => ({
    setupType: s._id as string,
    count: s.count as number,
    wins: s.wins as number,
    losses: s.losses as number,
    winRate: s.count > 0 ? ((s.wins as number) / (s.count as number)) * 100 : 0,
    avgPnlPercent: s.count > 0 ? (s.totalPnl as number) / (s.count as number) : 0,
  }));

  const byMarketCondition: MarketConditionPerformance[] = conditionAgg.map((c) => ({
    condition: c._id as string,
    count: c.count as number,
    wins: c.wins as number,
    losses: c.losses as number,
    winRate: c.count > 0 ? ((c.wins as number) / (c.count as number)) * 100 : 0,
    avgPnlPercent: c.count > 0 ? (c.totalPnl as number) / (c.count as number) : 0,
  }));

  const byMonth: MonthlyPnl[] = monthlyAgg.map((m) => ({
    month: m._id as string,
    pnlPercent: m.pnlPercent as number,
    tradeCount: m.tradeCount as number,
  }));

  const bySignalTier: SignalTierAccuracy[] = tierAgg.map((t) => ({
    tier: t._id as string,
    count: t.count as number,
    avgPnlPercent: t.count > 0 ? (t.totalPnl as number) / (t.count as number) : 0,
    winRate: t.count > 0 ? ((t.wins as number) / (t.count as number)) * 100 : 0,
  }));

  const bySession: SessionPerformance[] = sessionAgg.map((s) => ({
    session: s._id as string,
    count: s.count as number,
    wins: s.wins as number,
    winRate: s.count > 0 ? ((s.wins as number) / (s.count as number)) * 100 : 0,
    avgPnlPercent: s.count > 0 ? (s.totalPnl as number) / (s.count as number) : 0,
  }));

  const byHour: HourPerformance[] = hourAgg.map((h) => ({
    hour: h._id as number,
    count: h.count as number,
    wins: h.wins as number,
    winRate: h.count > 0 ? ((h.wins as number) / (h.count as number)) * 100 : 0,
    avgPnlPercent: h.count > 0 ? (h.totalPnl as number) / (h.count as number) : 0,
  }));

  const byWeekday: WeekdayPerformance[] = weekdayAgg.map((w) => ({
    weekday: ((w._id as number) - 1) % 7, // Mongo 1-7 (Sun-Sat) -> 0-6
    count: w.count as number,
    wins: w.wins as number,
    winRate: w.count > 0 ? ((w.wins as number) / (w.count as number)) * 100 : 0,
    avgPnlPercent: w.count > 0 ? (w.totalPnl as number) / (w.count as number) : 0,
  }));

  const byEmotion: EmotionPerformance[] = emotionAgg.map((e) => ({
    emotion: e._id as string,
    count: e.count as number,
    wins: e.wins as number,
    winRate: e.count > 0 ? ((e.wins as number) / (e.count as number)) * 100 : 0,
    avgPnlPercent: e.count > 0 ? (e.totalPnl as number) / (e.count as number) : 0,
  }));

  const byMistake: MistakePerformance[] = mistakeAgg.map((m) => ({
    mistake: m._id as string,
    count: m.count as number,
    avgPnlPercent: m.count > 0 ? (m.totalPnl as number) / (m.count as number) : 0,
    totalPnlPercent: m.totalPnl as number,
  }));

  // Per-trade streaks over the chronological closed-trade sequence
  const streaks = computeStreaks(pnlValues);

  // Kelly criterion from the real trade record (advisory position sizing)
  const kellySuggestion = computeKellySuggestion(pnlValues);

  return NextResponse.json({
    summary,
    incompleteTradeCount,
    byTag,
    byAction,
    bySetupType,
    byMarketCondition,
    byMonth,
    bySignalTier,
    bySession,
    byHour,
    byWeekday,
    byEmotion,
    byMistake,
    streaks,
    kellySuggestion,
  });
}

const KELLY_MIN_SAMPLE = 20;

function computeKellySuggestion(pnlValues: number[]): KellySuggestion {
  const winsArr = pnlValues.filter((v) => v > 0);
  const lossesArr = pnlValues.filter((v) => v < 0);
  const sampleSize = winsArr.length + lossesArr.length;
  const winRate = sampleSize > 0 ? winsArr.length / sampleSize : 0;
  const avgWinPercent = winsArr.length > 0 ? winsArr.reduce((s, v) => s + v, 0) / winsArr.length : 0;
  const avgLossPercent =
    lossesArr.length > 0 ? Math.abs(lossesArr.reduce((s, v) => s + v, 0) / lossesArr.length) : 0;

  let fraction = 0;
  if (avgWinPercent > 0 && avgLossPercent > 0) {
    const b = avgWinPercent / avgLossPercent;
    fraction = Math.max(0, (winRate * b - (1 - winRate)) / b);
  }

  return {
    fraction,
    halfFraction: fraction / 2,
    winRate,
    avgWinPercent,
    avgLossPercent,
    sampleSize,
    reliable: sampleSize >= KELLY_MIN_SAMPLE && winsArr.length > 0 && lossesArr.length > 0,
  };
}

function computeStreaks(pnlValues: number[]): TradeStreaks {
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let runType: 'win' | 'loss' | null = null;
  let runLength = 0;

  for (const pnl of pnlValues) {
    if (pnl === 0) {
      runType = null;
      runLength = 0;
      continue;
    }
    const type: 'win' | 'loss' = pnl > 0 ? 'win' : 'loss';
    if (type === runType) {
      runLength++;
    } else {
      runType = type;
      runLength = 1;
    }
    if (type === 'win') maxWinStreak = Math.max(maxWinStreak, runLength);
    else maxLossStreak = Math.max(maxLossStreak, runLength);
  }

  return {
    current: runType ? { type: runType, length: runLength } : null,
    maxWinStreak,
    maxLossStreak,
  };
}
