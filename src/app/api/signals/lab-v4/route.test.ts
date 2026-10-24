import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';
import {
  LAB_HYPOTHESES_V4,
  LAB_V4_HOLD_MS,
  LAB_V4_THRESHOLD,
  labDelayMs,
} from '@/lib/signals/lab/candidates';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  connectDB: vi.fn(),
  labScoreFindOne: vi.fn(),
  labScoreFind: vi.fn(),
  labScoreCountDocuments: vi.fn(),
  labSignalFindOne: vi.fn(),
  labSignalFind: vi.fn(),
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
    find: (...args: unknown[]) => mocks.labScoreFind(...args),
    countDocuments: (...args: unknown[]) => mocks.labScoreCountDocuments(...args),
  },
}));

vi.mock('@/lib/models/lab-signal', () => ({
  LabSignal: {
    findOne: (...args: unknown[]) => mocks.labSignalFindOne(...args),
    find: (...args: unknown[]) => mocks.labSignalFind(...args),
  },
}));

describe('GET /api/signals/lab-v4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.connectDB.mockResolvedValue(undefined);
    mocks.labScoreFindOne.mockImplementation(() => ({
      sort: () => ({
        lean: async () => null,
      }),
    }));
    const createFindChain = (items: unknown = []) => {
      const chain = {
        select: () => chain,
        sort: () => chain,
        lean: async () => items,
      };
      return chain;
    };
    mocks.labScoreFind.mockImplementation(() => createFindChain([]));
    mocks.labScoreCountDocuments.mockResolvedValue(0);
    mocks.labSignalFindOne.mockImplementation(() => ({
      sort: () => ({
        lean: async () => null,
      }),
    }));
    mocks.labSignalFind.mockImplementation(() => ({
      sort: () => ({
        lean: async () => [],
      }),
    }));
  });

  it('returns 401 when unauthenticated', async () => {
    mocks.auth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns 400 when symbol query param is invalid', async () => {
    const req = new Request('http://localhost/api/signals/lab-v4?symbol=invalid_symbol');
    const res = await GET(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid symbol parameter');
  });

  it('returns empty/not_started hypothesis views with threshold 800 for S1 and S2', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.version).toBe('lab-v4');
    expect(json.threshold).toBe(LAB_V4_THRESHOLD);
    expect(json.hypotheses).toHaveLength(2);

    expect(json.hypotheses[0]).toMatchObject({
      id: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      status: 'not_started',
      threshold: LAB_V4_THRESHOLD,
      scale: LAB_HYPOTHESES_V4[0].scale,
      meanNetReturn: null,
      meanNetPerTrade: null,
      openTrades: [],
      latestBar: null,
    });

    expect(json.hypotheses[1]).toMatchObject({
      id: 'S2-1h',
      candidate: 'S2',
      timeframe: '1h',
      status: 'not_started',
      threshold: LAB_V4_THRESHOLD,
      scale: LAB_HYPOTHESES_V4[1].scale,
      meanNetReturn: null,
      meanNetPerTrade: null,
      openTrades: [],
      latestBar: null,
    });
  });

  it('builds openTrades with enteredAt = barClose + D and exitsAt = enteredAt + hold', async () => {
    const now = Date.now();
    const D = labDelayMs('1h');
    const barClose = now - 2 * 3600_000;

    mocks.labSignalFind.mockImplementation((query: { barClose?: unknown }) => {
      // If querying openTrades
      if (query?.barClose && typeof query.barClose === 'object') {
        return {
          sort: () => ({
            lean: async () => [
              {
                hypothesis: 'S1-1h',
                barClose,
                scores: {
                  BTCUSDT: 1,
                  ETHUSDT: -1,
                  SOLUSDT: 0,
                },
              },
            ],
          }),
        };
      }
      return {
        sort: () => ({
          lean: async () => [],
        }),
      };
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    const s1 = json.hypotheses.find((h: { id: string }) => h.id === 'S1-1h');

    expect(s1.openTrades).toEqual([
      {
        symbol: 'BTCUSDT',
        side: 1,
        enteredAt: new Date(barClose + D).toISOString(),
        exitsAt: new Date(barClose + D + LAB_V4_HOLD_MS).toISOString(),
      },
      {
        symbol: 'ETHUSDT',
        side: -1,
        enteredAt: new Date(barClose + D).toISOString(),
        exitsAt: new Date(barClose + D + LAB_V4_HOLD_MS).toISOString(),
      },
    ]);
  });

  it('returns entries over the last 14 days when symbol is requested', async () => {
    const now = Date.now();
    const recentBarClose = now - 3 * 86_400_000;

    mocks.labSignalFind.mockImplementation((query: { barClose?: { $gte?: number } }) => {
      if (query?.barClose && '$gte' in query.barClose) {
        return {
          sort: () => ({
            lean: async () => [
              {
                hypothesis: 'S1-1h',
                barClose: recentBarClose,
                scores: { BTCUSDT: 1, ETHUSDT: -1 },
              },
              {
                hypothesis: 'S2-1h',
                barClose: recentBarClose + 3600_000,
                scores: { BTCUSDT: -1 },
              },
            ],
          }),
        };
      }
      return {
        sort: () => ({
          lean: async () => [],
        }),
      };
    });

    const req = new Request('http://localhost/api/signals/lab-v4?symbol=BTCUSDT');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.entries).toEqual([
      {
        hypothesis: 'S1-1h',
        barClose: new Date(recentBarClose).toISOString(),
        symbol: 'BTCUSDT',
        side: 1,
      },
      {
        hypothesis: 'S2-1h',
        barClose: new Date(recentBarClose + 3600_000).toISOString(),
        symbol: 'BTCUSDT',
        side: -1,
      },
    ]);
  });

  it('calculates meanNetReturn per bar and meanNetPerTrade per trade across betting bars', async () => {
    mocks.labScoreFind.mockImplementation((query: { bet?: boolean; hypothesis?: string }) => {
      if (query?.bet === true && query?.hypothesis === 'S1-1h') {
        return {
          sort: () => ({
            lean: async () => [
              { barClose: 1000, bet: true, netBookReturn: -0.002, n: 2 },
              { barClose: 2000, bet: true, netBookReturn: -0.001, n: 1 },
            ],
          }),
        };
      }
      return {
        sort: () => ({
          lean: async () => [],
        }),
      };
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    const s1 = json.hypotheses.find((h: { id: string }) => h.id === 'S1-1h');

    // meanNetReturn = (-0.002 + -0.001) / 2 = -0.0015
    expect(s1.meanNetReturn).toBeCloseTo(-0.0015, 6);
    // meanNetPerTrade = (-0.002 + -0.001) / (2 + 1) = -0.003 / 3 = -0.001
    expect(s1.meanNetPerTrade).toBeCloseTo(-0.001, 6);
  });

  it('returns empty closedTrades when symbol query param is omitted', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    for (const hyp of json.hypotheses) {
      expect(hyp.closedTrades).toEqual([]);
    }
  });

  it('returns closedTrades for requested symbol with won, cost, and wrong in order', async () => {
    const D = labDelayMs('1h');
    const t1 = 1_700_000_000_000;
    const t2 = t1 + 3_600_000;
    const t3 = t2 + 3_600_000;

    mocks.labScoreFind.mockImplementation((query: Record<string, unknown>) => {
      const chain = {
        select: () => chain,
        sort: () => chain,
        lean: async () => {
          if (query?.hypothesis === 'S1-1h' && 'weights.BTCUSDT' in query) {
            return [
              {
                barClose: t1,
                weights: { BTCUSDT: 1 },
                prices: { BTCUSDT: { start: 100, end: 102 } }, // +2% -> won
              },
              {
                barClose: t2,
                weights: { BTCUSDT: 1 },
                prices: { BTCUSDT: { start: 10000, end: 10005 } }, // +0.05% -> cost
              },
              {
                barClose: t3,
                weights: { BTCUSDT: 1 },
                prices: { BTCUSDT: { start: 100, end: 95 } }, // -5% -> wrong
              },
            ];
          }
          return [];
        },
      };
      return chain;
    });

    const req = new Request('http://localhost/api/signals/lab-v4?symbol=BTCUSDT');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    const s1 = json.hypotheses.find((h: { id: string }) => h.id === 'S1-1h');

    expect(s1.closedTrades).toHaveLength(3);
    expect(s1.closedTrades[0]).toEqual({
      symbol: 'BTCUSDT',
      side: 1,
      enteredAt: new Date(t1 + D).toISOString(),
      exitedAt: new Date(t1 + D + LAB_V4_HOLD_MS).toISOString(),
      move: expect.closeTo(0.02, 6),
      outcome: 'won',
    });
    expect(s1.closedTrades[1]).toEqual({
      symbol: 'BTCUSDT',
      side: 1,
      enteredAt: new Date(t2 + D).toISOString(),
      exitedAt: new Date(t2 + D + LAB_V4_HOLD_MS).toISOString(),
      move: expect.closeTo(0.0005, 6),
      outcome: 'cost',
    });
    expect(s1.closedTrades[2]).toEqual({
      symbol: 'BTCUSDT',
      side: 1,
      enteredAt: new Date(t3 + D).toISOString(),
      exitedAt: new Date(t3 + D + LAB_V4_HOLD_MS).toISOString(),
      move: expect.closeTo(-0.05, 6),
      outcome: 'wrong',
    });
  });

  it('skips a row without the requested symbol', async () => {
    const t1 = 1_700_000_000_000;

    mocks.labScoreFind.mockImplementation((query: Record<string, unknown>) => {
      const chain = {
        select: () => chain,
        sort: () => chain,
        lean: async () => {
          if (query?.hypothesis === 'S1-1h' && 'weights.BTCUSDT' in query) {
            return [
              {
                barClose: t1,
                weights: { ETHUSDT: 1 },
                prices: { ETHUSDT: { start: 2000, end: 2100 } },
              },
            ];
          }
          return [];
        },
      };
      return chain;
    });

    const req = new Request('http://localhost/api/signals/lab-v4?symbol=BTCUSDT');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    const s1 = json.hypotheses.find((h: { id: string }) => h.id === 'S1-1h');
    expect(s1.closedTrades).toEqual([]);
  });
});
