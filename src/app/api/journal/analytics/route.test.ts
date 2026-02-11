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
}));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { JournalEntry } from '@/lib/models/journal-entry';

const mockSession = { user: { id: 'user-1' } };

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
    vi.mocked(JournalEntry.find).mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    } as never);
    vi.mocked(JournalEntry.aggregate).mockResolvedValue([]);

    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.summary.totalTrades).toBe(0);
    expect(data.summary.wins).toBe(0);
    expect(data.summary.losses).toBe(0);
    expect(data.summary.winRate).toBe(0);
    expect(data.summary.profitFactor).toBeNull();
    expect(data.byTag).toEqual([]);
    expect(data.byAction).toEqual([]);
    expect(data.byMonth).toEqual([]);
  });

  it('computes summary from P&L entries', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(5);
    vi.mocked(JournalEntry.find).mockReturnValue({
      lean: vi.fn().mockResolvedValue([
        { outcomePnlPercent: 5 },
        { outcomePnlPercent: -2 },
        { outcomePnlPercent: 10 },
        { outcomePnlPercent: -3 },
      ]),
    } as never);
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
  });

  it('maps tag aggregation results', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(3);
    vi.mocked(JournalEntry.find).mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    } as never);

    // Make aggregate return different values per call
    const aggMock = vi.mocked(JournalEntry.aggregate);
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
    vi.mocked(JournalEntry.find).mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    } as never);

    const aggMock = vi.mocked(JournalEntry.aggregate);
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

  it('maps monthly P&L aggregation', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(5);
    vi.mocked(JournalEntry.find).mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    } as never);

    const aggMock = vi.mocked(JournalEntry.aggregate);
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
  });

  it('maps signal tier accuracy', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(5);
    vi.mocked(JournalEntry.find).mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    } as never);

    const aggMock = vi.mocked(JournalEntry.aggregate);
    aggMock.mockResolvedValueOnce([]); // tag
    aggMock.mockResolvedValueOnce([]); // action
    aggMock.mockResolvedValueOnce([]); // setup
    aggMock.mockResolvedValueOnce([]); // condition
    aggMock.mockResolvedValueOnce([]); // monthly
    aggMock.mockResolvedValueOnce([
      { _id: 'strong_buy', count: 4, totalPnl: 20, wins: 3 },
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

  it('maps setup type and market condition', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(5);
    vi.mocked(JournalEntry.find).mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    } as never);

    const aggMock = vi.mocked(JournalEntry.aggregate);
    aggMock.mockResolvedValueOnce([]); // tag
    aggMock.mockResolvedValueOnce([]); // action
    aggMock.mockResolvedValueOnce([
      { _id: 'breakout', count: 3, wins: 2, losses: 1, totalPnl: 6 },
    ]); // setup
    aggMock.mockResolvedValueOnce([
      { _id: 'trending_up', count: 4, wins: 3, losses: 1, totalPnl: 10 },
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
});
