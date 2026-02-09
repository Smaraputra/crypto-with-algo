// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/models/strategy', () => ({
  Strategy: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findOneAndDelete: vi.fn(),
  },
}));

import { GET, PATCH, DELETE } from './route';
import { auth } from '@/lib/auth';
import { Strategy } from '@/lib/models/strategy';

const mockSession = { user: { id: 'user-1' } };
const params = Promise.resolve({ id: 's1' });

function makePatchRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/strategies/s1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/strategies/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(new NextRequest('http://localhost/api/strategies/s1'), { params });
    expect(res.status).toBe(401);
  });

  it('returns strategy by id', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Strategy.findOne).mockResolvedValue({
      _id: 's1',
      name: 'Test',
      userId: 'user-1',
    } as never);

    const res = await GET(new NextRequest('http://localhost/api/strategies/s1'), { params });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.strategy.name).toBe('Test');
    expect(Strategy.findOne).toHaveBeenCalledWith({ _id: 's1', userId: 'user-1' });
  });

  it('returns 404 for non-existent strategy', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Strategy.findOne).mockResolvedValue(null);

    const res = await GET(new NextRequest('http://localhost/api/strategies/s1'), { params });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/strategies/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await PATCH(makePatchRequest({ name: 'Updated' }), { params });
    expect(res.status).toBe(401);
  });

  it('updates a strategy', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Strategy.findOneAndUpdate).mockResolvedValue({
      _id: 's1',
      name: 'Updated',
      userId: 'user-1',
    } as never);

    const res = await PATCH(makePatchRequest({ name: 'Updated' }), { params });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.strategy.name).toBe('Updated');
  });

  it('returns 404 for non-existent strategy', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Strategy.findOneAndUpdate).mockResolvedValue(null);

    const res = await PATCH(makePatchRequest({ name: 'Updated' }), { params });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid update data', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await PATCH(makePatchRequest({ intervals: ['5m'] }), { params });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/strategies/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await DELETE(new NextRequest('http://localhost/api/strategies/s1'), { params });
    expect(res.status).toBe(401);
  });

  it('deletes a strategy', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Strategy.findOneAndDelete).mockResolvedValue({ _id: 's1' } as never);

    const res = await DELETE(new NextRequest('http://localhost/api/strategies/s1'), { params });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('returns 404 for non-existent strategy', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Strategy.findOneAndDelete).mockResolvedValue(null);

    const res = await DELETE(new NextRequest('http://localhost/api/strategies/s1'), { params });
    expect(res.status).toBe(404);
  });
});
