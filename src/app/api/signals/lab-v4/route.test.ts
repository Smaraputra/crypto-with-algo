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
});
