import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  connectDB: vi.fn(),
  labScoreFindOne: vi.fn(),
  labScoreFind: vi.fn(),
  labScoreCountDocuments: vi.fn(),
  labSignalFindOne: vi.fn(),
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
  },
}));

describe('GET /api/signals/lab-v2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.connectDB.mockResolvedValue(undefined);
    mocks.labScoreFindOne.mockImplementation(() => ({
      sort: () => ({
        lean: async () => null,
      }),
    }));
    mocks.labScoreFind.mockImplementation(() => ({
      sort: () => ({
        lean: async () => [],
      }),
    }));
    mocks.labScoreCountDocuments.mockResolvedValue(0);
    mocks.labSignalFindOne.mockImplementation(() => ({
      sort: () => ({
        lean: async () => null,
      }),
    }));
  });

  it('returns 401 when signed out', async () => {
    mocks.auth.mockResolvedValue(null);

    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unauthorized' });
  });

  it('returns two hypotheses with threshold 400 and default values when no rows exist', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.version).toBe('lab-v2');
    expect(body.threshold).toBe(400);
    expect(body.hypotheses).toHaveLength(2);

    expect(body.hypotheses.map((h: { id: string }) => h.id)).toEqual(['N2-1w', 'N3-1d']);
    for (const hyp of body.hypotheses) {
      expect(hyp.status).toBe('not_started');
      expect(hyp.threshold).toBe(400);
      expect(hyp.e).toBe(1);
      expect(hyp.absorbed).toBe(false);
      expect(hyp.meanNetReturn).toBeNull();
      expect(hyp.lastNetReturn).toBeNull();
      expect(hyp.latestBar).toBeNull();
    }
  });

  it('returns hypotheses with right meanNetReturn, cash and threshold 400 for graded N3 and cash N2', async () => {
    const n3BarClose = 1_700_100_000_000;
    const n2BarClose = 1_700_000_000_000;

    mocks.labScoreFindOne.mockImplementation((query: { hypothesis?: string }) => ({
      sort: () => ({
        lean: async () => {
          if (query.hypothesis === 'N3-1d') {
            return {
              hypothesis: 'N3-1d',
              barClose: n3BarClose,
              netBookReturn: 0.01,
              bet: true,
              state: {
                n: 1,
                sumD: 0.01,
                sumD2: 0.0001,
                sumX: 0.01,
                sumX2: 0.0001,
                logE: Math.log(1.5),
                logE0: 0,
                crossedAt: null,
              },
            };
          }
          if (query.hypothesis === 'N2-1w') {
            return {
              hypothesis: 'N2-1w',
              barClose: n2BarClose,
              netBookReturn: null,
              bet: false,
              state: {
                n: 0,
                sumD: 0,
                sumD2: 0,
                sumX: 0,
                sumX2: 0,
                logE: 0,
                logE0: 0,
                crossedAt: null,
              },
            };
          }
          return null;
        },
      }),
    }));

    mocks.labScoreFind.mockImplementation((query: { hypothesis?: string; bet?: boolean }) => ({
      sort: () => ({
        lean: async () => {
          if (query.hypothesis === 'N3-1d' && query.bet) {
            return [{ barClose: n3BarClose, netBookReturn: 0.01 }];
          }
          return [];
        },
      }),
    }));

    mocks.labScoreCountDocuments.mockImplementation(async () => 1);

    mocks.labSignalFindOne.mockImplementation((query: { hypothesis?: string }) => ({
      sort: () => ({
        lean: async () => {
          if (query.hypothesis === 'N3-1d') {
            return {
              hypothesis: 'N3-1d',
              barClose: n3BarClose,
              late: false,
              scores: { BTCUSDT: 1 },
            };
          }
          if (query.hypothesis === 'N2-1w') {
            return {
              hypothesis: 'N2-1w',
              barClose: n2BarClose,
              late: false,
              scores: {},
            };
          }
          return null;
        },
      }),
    }));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.version).toBe('lab-v2');
    expect(body.threshold).toBe(400);
    expect(body.hypotheses).toHaveLength(2);

    const n3 = body.hypotheses.find((h: { id: string }) => h.id === 'N3-1d');
    expect(n3).toBeDefined();
    expect(n3.threshold).toBe(400);
    expect(n3.scale).toBe(0.8);
    expect(n3.meanNetReturn).toBe(0.01);
    expect(n3.lastNetReturn).toBe(0.01);
    expect(n3.absorbed).toBe(false);
    expect(n3.latestBar).not.toBeNull();
    expect(n3.latestBar.cash).toBe(false);
    expect(n3.latestBar.positions).toEqual([{ symbol: 'BTCUSDT', weight: 1 }]);

    const n2 = body.hypotheses.find((h: { id: string }) => h.id === 'N2-1w');
    expect(n2).toBeDefined();
    expect(n2.threshold).toBe(400);
    expect(n2.scale).toBe(0.13);
    expect(n2.meanNetReturn).toBeNull();
    expect(n2.lastNetReturn).toBeNull();
    expect(n2.absorbed).toBe(false);
    expect(n2.latestBar).not.toBeNull();
    expect(n2.latestBar.cash).toBe(true);
    expect(n2.latestBar.positions).toEqual([]);
  });

  it('returns e 0 and absorbed true for an absorbed state', async () => {
    mocks.labScoreFindOne.mockImplementation((query: { hypothesis?: string }) => ({
      sort: () => ({
        lean: async () => {
          if (query.hypothesis === 'N2-1w') {
            return {
              barClose: 1_700_000_000_000,
              state: {
                n: 10,
                sumD: -2,
                sumD2: 4,
                sumX: -2,
                sumX2: 4,
                logE: -Infinity,
                logE0: 0,
                crossedAt: null,
                absorbed: true,
              },
            };
          }
          return null;
        },
      }),
    }));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    const n2 = body.hypotheses.find((h: { id: string }) => h.id === 'N2-1w');
    expect(n2.e).toBe(0);
    expect(n2.absorbed).toBe(true);
  });

  it('returns 500 when database throws an error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.labScoreFindOne.mockImplementation(() => {
      throw new Error('Database query failed');
    });

    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Internal server error' });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
