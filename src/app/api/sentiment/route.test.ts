// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/external/fear-greed', () => ({
  fetchFearAndGreed: vi.fn(),
}));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { fetchFearAndGreed } from '@/lib/external/fear-greed';

const mockSession = { user: { id: 'user-1' } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/sentiment', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns sentiment data', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(fetchFearAndGreed).mockResolvedValue({
      fearGreedIndex: 42,
      label: 'Fear',
    });

    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.sentiment.fearGreedIndex).toBe(42);
    expect(data.sentiment.label).toBe('Fear');
  });

  it('returns 500 on fetch error', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(fetchFearAndGreed).mockRejectedValue(new Error('API error'));

    const res = await GET();
    expect(res.status).toBe(500);
  });
});
