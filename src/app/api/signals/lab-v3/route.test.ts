import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';
import { LAB_HYPOTHESES_V3 } from '@/lib/signals/lab/candidates';

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

describe('GET /api/signals/lab-v3', () => {
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

  it('returns 401 when unauthenticated', async () => {
    mocks.auth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns empty/not_started hypothesis view initially with threshold 200', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.version).toBe('lab-v3');
    expect(json.threshold).toBe(200);
    expect(json.hypotheses).toHaveLength(1);
    expect(json.hypotheses[0]).toMatchObject({
      id: 'F1-1d',
      candidate: 'F1',
      timeframe: '1d',
      status: 'not_started',
      threshold: 200,
      scale: LAB_HYPOTHESES_V3[0].scale,
    });
  });

  it('returns active positions when latestSignal exists', async () => {
    mocks.labSignalFindOne.mockImplementation(() => ({
      sort: () => ({
        lean: async () => ({
          barClose: Date.UTC(2026, 9, 20),
          late: false,
          scores: {
            BTCUSDT: 0.5,
            ETHUSDT: -0.5,
          },
        }),
      }),
    }));

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    const hyp = json.hypotheses[0];
    expect(hyp.latestBar).not.toBeNull();
    expect(hyp.latestBar.positions).toEqual([
      { symbol: 'BTCUSDT', weight: 0.5 },
      { symbol: 'ETHUSDT', weight: -0.5 },
    ]);
  });
});
