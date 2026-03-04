// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/external/crypto-news', () => ({
  fetchCryptoNews: vi.fn(),
}));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { fetchCryptoNews } from '@/lib/external/crypto-news';

const mockSession = { user: { id: 'user-1' } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/news', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(new NextRequest('http://localhost/api/news'));
    expect(res.status).toBe(401);
  });

  it('returns news articles', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(fetchCryptoNews).mockResolvedValue([
      { id: '1', title: 'BTC News', url: 'u', source: 's', body: 'b', categories: 'BTC', publishedOn: 0, imageUrl: null },
    ]);

    const res = await GET(new NextRequest('http://localhost/api/news'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.articles).toHaveLength(1);
  });

  it('passes categories filter', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(fetchCryptoNews).mockResolvedValue([]);

    await GET(new NextRequest('http://localhost/api/news?categories=BTC,ETH'));

    expect(fetchCryptoNews).toHaveBeenCalledWith('BTC,ETH');
  });

  it('returns 500 with generic message on fetch error (no leakage)', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(fetchCryptoNews).mockRejectedValue(new Error('Secret API key invalid at https://internal.api/v1'));

    const res = await GET(new NextRequest('http://localhost/api/news'));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Failed to fetch news');
    expect(data.error).not.toContain('Secret');
    expect(data.error).not.toContain('internal.api');
  });
});
