import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  connectDB: vi.fn(),
  labScoreFindOne: vi.fn(),
  labScoreCountDocuments: vi.fn(),
  labSignalFindOne: vi.fn(),
  rvSignalFindOne: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  auth: () => mocks.auth(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: () => mocks.connectDB(),
}));

vi.mock('@/lib/models/lab-score', () => ({
  LabScore: {
    findOne: (...args: unknown[]) => mocks.labScoreFindOne(...args),
    countDocuments: (...args: unknown[]) => mocks.labScoreCountDocuments(...args),
  },
}));

vi.mock('@/lib/models/lab-signal', () => ({
  LabSignal: {
    findOne: (...args: unknown[]) => mocks.labSignalFindOne(...args),
  },
}));

vi.mock('@/lib/models/rv-signal', () => ({
  RvSignal: {
    findOne: (...args: unknown[]) => mocks.rvSignalFindOne(...args),
  },
}));

describe('GET /api/signals/lab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.connectDB.mockResolvedValue(undefined);
    mocks.labScoreFindOne.mockImplementation(() => ({
      sort: () => ({
        lean: async () => null,
      }),
    }));
    mocks.labScoreCountDocuments.mockResolvedValue(0);
    mocks.labSignalFindOne.mockImplementation(() => ({
      sort: () => ({
        lean: async () => null,
      }),
    }));
    mocks.rvSignalFindOne.mockImplementation(() => ({
      lean: async () => null,
    }));
  });

  it('returns 401 without a session', async () => {
    mocks.auth.mockResolvedValue(null);

    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 8 hypotheses in registry order with default state when no rows exist', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.version).toBe('lab-v1');
    expect(body.threshold).toBe(800);
    expect(body.hypotheses).toHaveLength(8);

    const expectedIds = ['L1-8h', 'L2-5m', 'L2-15m', 'L2-1h', 'L2-4h', 'L2-1d', 'L3-8h', 'L4-8h'];
    expect(body.hypotheses.map((h: { id: string }) => h.id)).toEqual(expectedIds);

    for (const hyp of body.hypotheses) {
      expect(hyp.status).toBe('not_started');
      expect(hyp.e).toBe(1);
      expect(hyp.e0).toBe(1);
      expect(hyp.gradedBars).toBe(0);
      expect(hyp.betBars).toBe(0);
      expect(hyp.latestBar).toBeNull();
      expect(hyp.threshold).toBe(800);
      expect(hyp.meanX).toBeNull();
      expect(hyp.meanB).toBeNull();
      expect(hyp.currentB).toBeNull();
      expect(hyp.underTestSince).toBeNull();
      expect(hyp.testEndsAt).toBeNull();
      expect(hyp.validatedAt).toBeNull();
    }
  });

  it('maps graded rows for a hypothesis under test', async () => {
    const firstBarClose = Date.now() - 30 * 24 * 3600 * 1000;
    const latestBarClose = firstBarClose + 100_000;

    mocks.labScoreFindOne.mockImplementation((query: { hypothesis?: string }) => ({
      sort: (sortCriteria: { barClose?: number }) => ({
        lean: async () => {
          if (query.hypothesis === 'L1-8h') {
            if (sortCriteria?.barClose === 1) {
              return { barClose: firstBarClose };
            }
            if (sortCriteria?.barClose === -1) {
              return {
                barClose: latestBarClose,
                b: 0.05,
                state: {
                  n: 40,
                  sumX: 4,
                  sumD: 2,
                  sumX2: 0,
                  sumD2: 0,
                  logE: Math.log(5),
                  logE0: Math.log(3),
                  crossedAt: null,
                },
              };
            }
          }
          return null;
        },
      }),
    }));

    mocks.labScoreCountDocuments.mockImplementation(async (query: { hypothesis?: string }) => {
      return query.hypothesis === 'L1-8h' ? 40 : 0;
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    const target = body.hypotheses.find((h: { id: string }) => h.id === 'L1-8h');
    expect(target).toBeDefined();
    expect(target.status).toBe('under_test');
    expect(target.e).toBeCloseTo(5);
    expect(target.meanX).toBeCloseTo(0.1);
    expect(target.meanB).toBeCloseTo(0.05);
    expect(target.betBars).toBe(40);
    expect(target.gradedBars).toBe(40);
    expect(target.currentB).toBe(0.05);
    expect(target.underTestSince).toBe(new Date(firstBarClose).toISOString());
  });

  it('returns status validated and validatedAt as ISO when crossedAt is set', async () => {
    const firstBarClose = 1_700_000_000_000;
    const crossedAt = 1_700_050_000_000;

    mocks.labScoreFindOne.mockImplementation((query: { hypothesis?: string }) => ({
      sort: (sortCriteria: { barClose?: number }) => ({
        lean: async () => {
          if (query.hypothesis === 'L1-8h') {
            if (sortCriteria?.barClose === 1) {
              return { barClose: firstBarClose };
            }
            if (sortCriteria?.barClose === -1) {
              return {
                barClose: 1_700_100_000_000,
                b: 0.02,
                state: {
                  n: 50,
                  sumX: 5,
                  sumD: 3,
                  sumX2: 0,
                  sumD2: 0,
                  logE: Math.log(820),
                  logE0: 0,
                  crossedAt,
                },
              };
            }
          }
          return null;
        },
      }),
    }));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    const target = body.hypotheses.find((h: { id: string }) => h.id === 'L1-8h');
    expect(target.status).toBe('validated');
    expect(target.validatedAt).toBe(new Date(crossedAt).toISOString());
  });

  it('enriches L2 latest signals with parts.v8 and parts.rvRank from RvSignal', async () => {
    const rvBarTime = 1_700_000_000_000;
    const signalBarClose = 1_700_060_000_000;

    mocks.labSignalFindOne.mockImplementation((query: { hypothesis?: string }) => ({
      sort: () => ({
        lean: async () => {
          if (query.hypothesis === 'L2-15m') {
            return {
              hypothesis: 'L2-15m',
              candidate: 'L2',
              timeframe: '15m',
              barClose: signalBarClose,
              late: false,
              scores: {
                BTCUSDT: 80,
                ETHUSDT: 60,
              },
              skipped: [{ symbol: 'SOLUSDT', reason: 'v8_missing' }],
              inputs: {
                rvBarTime,
                v8: {
                  BTCUSDT: { score: 90 },
                  ETHUSDT: { score: 40 },
                },
              },
            };
          }
          return null;
        },
      }),
    }));

    mocks.rvSignalFindOne.mockImplementation((query: { version?: string; barTime?: number }) => ({
      lean: async () => {
        if (query.version === 'rv-v1' && query.barTime === rvBarTime) {
          return {
            version: 'rv-v1',
            barTime: rvBarTime,
            ranked: [
              { symbol: 'BTCUSDT', rank: 2 },
              { symbol: 'ETHUSDT', rank: 5 },
            ],
          };
        }
        return null;
      },
    }));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    const target = body.hypotheses.find((h: { id: string }) => h.id === 'L2-15m');
    expect(target.latestBar).not.toBeNull();
    expect(target.latestBar.barClose).toBe(new Date(signalBarClose).toISOString());
    expect(target.latestBar.late).toBe(false);
    expect(target.latestBar.skipped).toEqual([{ symbol: 'SOLUSDT', reason: 'v8_missing' }]);
    expect(target.latestBar.coins).toEqual([
      { symbol: 'BTCUSDT', score: 80, rank: 1, parts: { v8: 90, rvRank: 2 } },
      { symbol: 'ETHUSDT', score: 60, rank: 2, parts: { v8: 40, rvRank: 5 } },
    ]);
  });

  it('returns 500 when a model throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.labScoreFindOne.mockImplementation(() => {
      throw new Error('Database error');
    });

    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Internal server error' });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
