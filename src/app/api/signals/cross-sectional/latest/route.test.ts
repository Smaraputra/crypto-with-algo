import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockAuth = vi.fn();
const mockSignalFindOne = vi.fn();
const mockBookFindOne = vi.fn();
const mockConnectDB = vi.fn();

vi.mock('@/lib/auth', () => ({
  auth: () => mockAuth(),
}));

vi.mock('@/lib/models/cross-sectional-signal', () => ({
  CrossSectionalSignal: {
    findOne: (...args: unknown[]) => mockSignalFindOne(...args),
  },
}));

vi.mock('@/lib/models/cross-sectional-book', () => ({
  CrossSectionalBook: {
    findOne: (...args: unknown[]) => mockBookFindOne(...args),
  },
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: () => mockConnectDB(),
}));

describe('GET /api/signals/cross-sectional/latest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'user1' } });
    mockConnectDB.mockResolvedValue(undefined);
  });

  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns latest signal and book data when authenticated', async () => {
    const mockSignal = {
      timestamp: 1700000000000,
      targets: [{ symbol: 'BTCUSDT', weight: 0.25, side: 'long' }],
      netBetaExposure: 0,
      grossExposure: 1.0,
    };
    const mockBook = {
      bookName: 'rv-8h-buffer2',
      equityMaker: 10250,
      equityTaker: 10100,
      positions: [],
    };

    mockSignalFindOne.mockReturnValue({
      sort: () => ({
        lean: () => Promise.resolve(mockSignal),
      }),
    });

    mockBookFindOne.mockReturnValue({
      lean: () => Promise.resolve(mockBook),
    });

    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.signal).toEqual(mockSignal);
    expect(json.book).toEqual(mockBook);
  });

  it('handles null records cleanly when collections are empty', async () => {
    mockSignalFindOne.mockReturnValue({
      sort: () => ({
        lean: () => Promise.resolve(null),
      }),
    });

    mockBookFindOne.mockReturnValue({
      lean: () => Promise.resolve(null),
    });

    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.signal).toBeNull();
    expect(json.book).toBeNull();
  });
});
