// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/models/journal-entry', () => ({
  JournalEntry: {
    countDocuments: vi.fn(),
    find: vi.fn(() => ({
      lean: vi.fn(),
    })),
    aggregate: vi.fn(),
  },
  // The route filters on this; it is the real value, not a stub, so a change
  // to the action vocabulary surfaces here rather than passing silently.
  POSITION_ACTIONS: ['buy', 'sell'],
}));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { JournalEntry } from '@/lib/models/journal-entry';
import { EFFECTIVE_ENTERED_AT } from '@/lib/journal/times';

const mockSession = { user: { id: 'user-1' } };

function mockFind(entries: unknown[] = []) {
  vi.mocked(JournalEntry.find).mockReturnValue({
    lean: vi.fn().mockResolvedValue(entries),
    sort: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(entries),
    }),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/journal/analytics', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns analytics with empty data', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);
    mockFind([]);
    vi.mocked(JournalEntry.aggregate).mockResolvedValue([]);

    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.summary.totalTrades).toBe(0);
    expect(data.summary.wins).toBe(0);
    expect(data.summary.losses).toBe(0);
    // null, not 0: a 0% win rate reads as "you lost every trade" when in fact
    // nothing has been closed. The PnL strip already showed a dash here while
    // the analytics cards showed 0.0% for the same data.
    expect(data.summary.winRate).toBeNull();
    expect(data.summary.profitFactor).toBeNull();
    expect(data.incompleteTradeCount).toBe(0);
    expect(data.byTag).toEqual([]);
    expect(data.byAction).toEqual([]);
    expect(data.byMonth).toEqual([]);
  });

  it('computes summary from P&L entries', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const countMock = vi.mocked(JournalEntry.countDocuments);
    countMock.mockResolvedValueOnce(5); // allEntries
    countMock.mockResolvedValueOnce(2); // incompleteTradeCount
    mockFind([
      { outcomePnlPercent: 5 },
      { outcomePnlPercent: -2 },
      { outcomePnlPercent: 10 },
      { outcomePnlPercent: -3 },
    ]);
    vi.mocked(JournalEntry.aggregate).mockResolvedValue([]);

    const res = await GET();
    const data = await res.json();

    expect(data.summary.totalTrades).toBe(5);
    expect(data.summary.wins).toBe(2);
    expect(data.summary.losses).toBe(2);
    expect(data.summary.winRate).toBe(50);
    expect(data.summary.bestTrade).toBe(10);
    expect(data.summary.worstTrade).toBe(-3);
    expect(data.summary.totalPnlPercent).toBe(10);
    expect(data.summary.profitFactor).toBe(3); // 15 / 5
    expect(data.incompleteTradeCount).toBe(2);
  });

  it('maps tag aggregation results', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(3);
    mockFind([]);

    // Make aggregate return different values per call
    const aggMock = vi.mocked(JournalEntry.aggregate);
    aggMock.mockResolvedValue([] as never); // base fallback for trailing aggregations
    // Call order: tagAgg, actionAgg, setupAgg, conditionAgg, monthlyAgg, tierAgg
    aggMock.mockResolvedValueOnce([
      { _id: 'breakout', count: 5, wins: 3, losses: 2, totalPnl: 8 },
    ]);
    aggMock.mockResolvedValueOnce([
      { _id: 'buy', count: 3 },
    ]);
    aggMock.mockResolvedValueOnce([]);
    aggMock.mockResolvedValueOnce([]);
    aggMock.mockResolvedValueOnce([]);
    aggMock.mockResolvedValueOnce([]);

    const res = await GET();
    const data = await res.json();

    expect(data.byTag).toHaveLength(1);
    expect(data.byTag[0].tag).toBe('breakout');
    expect(data.byTag[0].winRate).toBe(60);
    expect(data.byTag[0].avgPnlPercent).toBeCloseTo(1.6);
  });

  it('maps action distribution', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(10);
    mockFind([]);

    const aggMock = vi.mocked(JournalEntry.aggregate);
    aggMock.mockResolvedValue([] as never); // base fallback for trailing aggregations
    aggMock.mockResolvedValueOnce([]); // tag
    aggMock.mockResolvedValueOnce([
      { _id: 'buy', count: 6 },
      { _id: 'sell', count: 4 },
    ]); // action
    aggMock.mockResolvedValueOnce([]); // setup
    aggMock.mockResolvedValueOnce([]); // condition
    aggMock.mockResolvedValueOnce([]); // monthly
    aggMock.mockResolvedValueOnce([]); // tier

    const res = await GET();
    const data = await res.json();

    expect(data.byAction).toHaveLength(2);
    expect(data.byAction[0].action).toBe('buy');
    expect(data.byAction[0].percentage).toBe(60);
    expect(data.byAction[1].percentage).toBe(40);
  });

  it('maps monthly P&L aggregation and uses EFFECTIVE_ENTERED_AT in _id', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(5);
    mockFind([]);

    const aggMock = vi.mocked(JournalEntry.aggregate);
    aggMock.mockResolvedValue([] as never); // base fallback for trailing aggregations
    aggMock.mockResolvedValueOnce([]); // tag
    aggMock.mockResolvedValueOnce([]); // action
    aggMock.mockResolvedValueOnce([]); // setup
    aggMock.mockResolvedValueOnce([]); // condition
    aggMock.mockResolvedValueOnce([
      { _id: '2025-01', pnlPercent: 12.5, tradeCount: 3 },
      { _id: '2025-02', pnlPercent: -4.2, tradeCount: 2 },
    ]); // monthly
    aggMock.mockResolvedValueOnce([]); // tier

    const res = await GET();
    const data = await res.json();

    expect(data.byMonth).toHaveLength(2);
    expect(data.byMonth[0].month).toBe('2025-01');
    expect(data.byMonth[0].pnlPercent).toBe(12.5);
    expect(data.byMonth[1].pnlPercent).toBe(-4.2);

    // Assert that the monthly aggregate call used EFFECTIVE_ENTERED_AT
    const monthlyCall = aggMock.mock.calls[4][0] as unknown as Array<Record<string, unknown>>;
    const groupStage = monthlyCall.find((s) => '$group' in s)?.$group as {
      _id: { $dateToString: { format: string; date: unknown } };
    };
    expect(groupStage._id.$dateToString.date).toEqual(EFFECTIVE_ENTERED_AT);
  });

  it('sorts pnlEntries chronologically by effective time in JS', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(2);
    // Entry 1 has older createdAt (2026-01-01) but later enteredAt (2026-01-05), outcome: +5 (win)
    // Entry 2 has later createdAt (2026-01-03) but earlier enteredAt (2026-01-02), outcome: -5 (loss)
    // When sorted by effective time: Entry 2 (-5), then Entry 1 (+5) -> current streak is win of length 1
    mockFind([
      {
        outcomePnlPercent: 5,
        action: 'buy',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        enteredAt: new Date('2026-01-05T00:00:00.000Z'),
      },
      {
        outcomePnlPercent: -5,
        action: 'buy',
        createdAt: new Date('2026-01-03T00:00:00.000Z'),
        enteredAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]);
    vi.mocked(JournalEntry.aggregate).mockResolvedValue([]);

    const res = await GET();
    const data = await res.json();
    expect(data.streaks.current).toEqual({ type: 'win', length: 1 });
    expect(JournalEntry.find).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        enteredAt: 1,
        createdAt: 1,
      })
    );
  });

  it('maps signal tier accuracy', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(5);
    mockFind([]);

    const aggMock = vi.mocked(JournalEntry.aggregate);
    aggMock.mockResolvedValue([] as never); // base fallback for trailing aggregations
    aggMock.mockResolvedValueOnce([]); // tag
    aggMock.mockResolvedValueOnce([]); // action
    aggMock.mockResolvedValueOnce([]); // setup
    aggMock.mockResolvedValueOnce([]); // condition
    aggMock.mockResolvedValueOnce([]); // monthly
    aggMock.mockResolvedValueOnce([
      { _id: 'strong_buy', count: 8, totalPnl: 40, wins: 6 },
      { _id: 'buy', count: 6, totalPnl: -3, wins: 2 },
    ]); // tier

    const res = await GET();
    const data = await res.json();

    expect(data.bySignalTier).toHaveLength(2);
    expect(data.bySignalTier[0].tier).toBe('strong_buy');
    expect(data.bySignalTier[0].avgPnlPercent).toBe(5);
    expect(data.bySignalTier[0].winRate).toBe(75);
    expect(data.bySignalTier[1].avgPnlPercent).toBeCloseTo(-0.5);
  });

  it('suppresses a breakdown win rate below the minimum sample', async () => {
    // The defect this guards: with one closed trade a panel rendered
    // `1 trades - 100%` under a heading like "By Hour (UTC)", presenting an
    // hour-of-day edge from a single observation. A rate from n=1 has a standard
    // error of 50 points; it is not a weak finding, it is no finding.
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(1);
    mockFind([{ outcomePnlPercent: 5 }]);

    const aggMock = vi.mocked(JournalEntry.aggregate);
    aggMock.mockResolvedValueOnce([{ _id: 'breakout', count: 1, wins: 1, losses: 0, totalPnl: 5 }]); // tag
    aggMock.mockResolvedValueOnce([]); // action
    aggMock.mockResolvedValueOnce([{ _id: 'breakout', count: 1, wins: 1, losses: 0, totalPnl: 5 }]); // setup
    aggMock.mockResolvedValueOnce([]); // condition
    aggMock.mockResolvedValueOnce([]); // monthly
    aggMock.mockResolvedValueOnce([]); // tier
    aggMock.mockResolvedValueOnce([]); // session
    aggMock.mockResolvedValueOnce([{ _id: 14, count: 1, wins: 1, totalPnl: 5 }]); // hour
    aggMock.mockResolvedValueOnce([]); // weekday
    aggMock.mockResolvedValueOnce([]); // emotion
    aggMock.mockResolvedValueOnce([]); // mistake

    const res = await GET();
    const data = await res.json();

    // The count is still reported: the reader should see there IS one trade.
    expect(data.byTag[0].count).toBe(1);
    expect(data.byTag[0].winRate).toBeNull();
    expect(data.bySetupType[0].winRate).toBeNull();
    expect(data.byHour[0].winRate).toBeNull();
    // The headline rate is NOT suppressed at n=1: one closed trade is a real
    // result for the summary, unlike an hour-of-day breakdown.
    expect(data.summary.winRate).toBe(100);
  });

  it('maps setup type and market condition', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(5);
    mockFind([]);

    const aggMock = vi.mocked(JournalEntry.aggregate);
    aggMock.mockResolvedValue([] as never); // base fallback for trailing aggregations
    aggMock.mockResolvedValueOnce([]); // tag
    aggMock.mockResolvedValueOnce([]); // action
    aggMock.mockResolvedValueOnce([
      { _id: 'breakout', count: 6, wins: 4, losses: 2, totalPnl: 12 },
    ]); // setup
    aggMock.mockResolvedValueOnce([
      { _id: 'trending_up', count: 8, wins: 6, losses: 2, totalPnl: 20 },
    ]); // condition
    aggMock.mockResolvedValueOnce([]); // monthly
    aggMock.mockResolvedValueOnce([]); // tier

    const res = await GET();
    const data = await res.json();

    expect(data.bySetupType).toHaveLength(1);
    expect(data.bySetupType[0].setupType).toBe('breakout');
    expect(data.bySetupType[0].winRate).toBeCloseTo(66.67, 1);

    expect(data.byMarketCondition).toHaveLength(1);
    expect(data.byMarketCondition[0].condition).toBe('trending_up');
    expect(data.byMarketCondition[0].winRate).toBe(75);
  });

  it('maps session, hour, and weekday aggregations', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(6);
    mockFind([]);

    const aggMock = vi.mocked(JournalEntry.aggregate);
    aggMock.mockResolvedValue([] as never); // base fallback
    // Call order: tag, action, setup, condition, monthly, tier, session, hour, weekday
    aggMock.mockResolvedValueOnce([]); // tag
    aggMock.mockResolvedValueOnce([]); // action
    aggMock.mockResolvedValueOnce([]); // setup
    aggMock.mockResolvedValueOnce([]); // condition
    aggMock.mockResolvedValueOnce([]); // monthly
    aggMock.mockResolvedValueOnce([]); // tier
    aggMock.mockResolvedValueOnce([
      { _id: 'asia', count: 8, wins: 6, totalPnl: 16 },
      { _id: 'ny_overlap', count: 2, wins: 0, totalPnl: -3 },
    ]); // session
    aggMock.mockResolvedValueOnce([
      { _id: 9, count: 6, wins: 4, totalPnl: 9 },
    ]); // hour
    aggMock.mockResolvedValueOnce([
      { _id: 1, count: 2, wins: 1, totalPnl: 1 }, // Mongo 1 = Sunday
      { _id: 2, count: 8, wins: 6, totalPnl: 12 }, // Mongo 2 = Monday
    ]); // weekday

    const res = await GET();
    const data = await res.json();

    expect(data.bySession).toHaveLength(2);
    expect(data.bySession[0]).toEqual({
      session: 'asia',
      count: 8,
      wins: 6,
      winRate: 75,
      avgPnlPercent: 2,
    });

    expect(data.byHour).toHaveLength(1);
    expect(data.byHour[0].hour).toBe(9);
    expect(data.byHour[0].winRate).toBeCloseTo(66.67, 1);

    // Mongo $dayOfWeek 1-7 maps to 0-6 (Sunday = 0)
    expect(data.byWeekday[0].weekday).toBe(0);
    expect(data.byWeekday[1].weekday).toBe(1);
    expect(data.byWeekday[1].winRate).toBe(75);
  });

  it('maps emotion and mistake aggregations and computes streaks', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(6);
    // Chronological closed trades: W W L L L W -> current 1 win, max 2 wins, max 3 losses
    mockFind([
      { outcomePnlPercent: 2, createdAt: new Date(1) },
      { outcomePnlPercent: 1, createdAt: new Date(2) },
      { outcomePnlPercent: -1, createdAt: new Date(3) },
      { outcomePnlPercent: -2, createdAt: new Date(4) },
      { outcomePnlPercent: -0.5, createdAt: new Date(5) },
      { outcomePnlPercent: 3, createdAt: new Date(6) },
    ]);

    const aggMock = vi.mocked(JournalEntry.aggregate);
    aggMock.mockResolvedValue([] as never); // base fallback
    // Call order: tag, action, setup, condition, monthly, tier, session, hour, weekday, emotion, mistake
    for (let i = 0; i < 9; i++) aggMock.mockResolvedValueOnce([]);
    aggMock.mockResolvedValueOnce([
      { _id: 'fomo', count: 8, wins: 2, totalPnl: -12 },
      { _id: 'calm', count: 10, wins: 7, totalPnl: 12 },
    ]); // emotion
    aggMock.mockResolvedValueOnce([
      { _id: 'chased_entry', count: 3, totalPnl: -4.5 },
      { _id: 'moved_stop', count: 5, totalPnl: -10 },
    ]); // mistake

    const res = await GET();
    const data = await res.json();

    expect(data.byEmotion).toHaveLength(2);
    expect(data.byEmotion[0]).toEqual({
      emotion: 'fomo',
      count: 8,
      wins: 2,
      winRate: 25,
      avgPnlPercent: -1.5,
    });

    // Three trades is below ANALYTICS_MIN_SAMPLE_FOR_RATE, so the average is
    // suppressed the same way a win rate is. The total is still reported: it is
    // a fact about the journal, not an estimate of an edge.
    expect(data.byMistake[0]).toEqual({
      mistake: 'chased_entry',
      count: 3,
      avgPnlPercent: null,
      totalPnlPercent: -4.5,
    });

    // At the threshold the average is stated.
    expect(data.byMistake[1]).toEqual({
      mistake: 'moved_stop',
      count: 5,
      avgPnlPercent: -2,
      totalPnlPercent: -10,
    });

    expect(data.streaks).toEqual({
      current: { type: 'win', length: 1 },
      maxWinStreak: 2,
      maxLossStreak: 3,
    });
  });

  it('computes a Kelly suggestion from closed trades', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(30);
    // 24 trades: 60% winners at +2%, losers at -1% -> b=2, f = (0.6*2 - 0.4)/2 = 0.4
    const entries = [
      ...Array.from({ length: 15 }, (_, i) => ({ outcomePnlPercent: 2, createdAt: new Date(i) })),
      ...Array.from({ length: 10 }, (_, i) => ({ outcomePnlPercent: -1, createdAt: new Date(15 + i) })),
    ];
    mockFind(entries);
    vi.mocked(JournalEntry.aggregate).mockResolvedValue([] as never);

    const res = await GET();
    const data = await res.json();

    expect(data.kellySuggestion.reliable).toBe(true);
    expect(data.kellySuggestion.sampleSize).toBe(25);
    expect(data.kellySuggestion.winRate).toBeCloseTo(0.6);
    expect(data.kellySuggestion.fraction).toBeCloseTo(0.4);
    expect(data.kellySuggestion.halfFraction).toBeCloseTo(0.2);
  });

  it('marks Kelly unreliable under 20 closed trades', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(5);
    mockFind([
      { outcomePnlPercent: 2, createdAt: new Date(1) },
      { outcomePnlPercent: -1, createdAt: new Date(2) },
    ]);
    vi.mocked(JournalEntry.aggregate).mockResolvedValue([] as never);

    const res = await GET();
    const data = await res.json();

    expect(data.kellySuggestion.reliable).toBe(false);
    expect(data.kellySuggestion.sampleSize).toBe(2);
  });
});
