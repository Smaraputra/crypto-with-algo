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

describe('GET /api/journal/tags', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns distinct tags with counts', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.aggregate).mockResolvedValue([
      { _id: 'breakout', count: 5 },
      { _id: 'reversal', count: 3 },
    ] as never);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tags).toEqual([
      { tag: 'breakout', count: 5 },
      { tag: 'reversal', count: 3 },
    ]);
  });

  it('returns empty array when no tags', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.aggregate).mockResolvedValue([] as never);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tags).toEqual([]);
  });

  it('uses correct aggregation pipeline', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.aggregate).mockResolvedValue([] as never);

    await GET();
    expect(JournalEntry.aggregate).toHaveBeenCalledWith([
      { $match: { userId: 'user-1' } },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
  });
});
