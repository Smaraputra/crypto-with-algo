// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/models/alert', () => ({
  Alert: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findOneAndDelete: vi.fn(),
  },
}));

import { GET, PATCH, DELETE } from './route';
import { auth } from '@/lib/auth';
import { Alert } from '@/lib/models/alert';

const mockSession = { user: { id: 'user-1' } };
const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });

function makeRequest(body?: unknown, method = 'GET'): NextRequest {
  if (body === undefined) {
    return new NextRequest('http://localhost/api/alerts/a1', { method });
  }
  return new NextRequest('http://localhost/api/alerts/a1', {
    method,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/alerts/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET(makeRequest(), makeParams('a1'));
    expect(res.status).toBe(401);
  });

  it('returns alert by id', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Alert.findOne).mockResolvedValue({
      _id: 'a1',
      userId: 'user-1',
      type: 'price_above',
      symbol: 'BTCUSDT',
      targetPrice: 100000,
      status: 'active',
    } as never);

    const res = await GET(makeRequest(), makeParams('a1'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.alert.type).toBe('price_above');
    expect(data.alert.symbol).toBe('BTCUSDT');
  });

  it('returns 404 when not found or not owned', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Alert.findOne).mockResolvedValue(null);

    const res = await GET(makeRequest(), makeParams('nonexistent'));
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/alerts/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest({ status: 'paused' }, 'PATCH');
    const res = await PATCH(req, makeParams('a1'));
    expect(res.status).toBe(401);
  });

  it('updates alert status', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Alert.findOneAndUpdate).mockResolvedValue({
      _id: 'a1',
      status: 'paused',
      type: 'price_above',
    } as never);

    const req = makeRequest({ status: 'paused' }, 'PATCH');
    const res = await PATCH(req, makeParams('a1'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.alert.status).toBe('paused');
  });

  it('updates alert targetPrice', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Alert.findOneAndUpdate).mockResolvedValue({
      _id: 'a1',
      targetPrice: 110000,
    } as never);

    const req = makeRequest({ targetPrice: 110000 }, 'PATCH');
    const res = await PATCH(req, makeParams('a1'));
    expect(res.status).toBe(200);
    expect(Alert.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'a1', userId: 'user-1' },
      { targetPrice: 110000 },
      { new: true }
    );
  });

  it('updates notifiedAt to acknowledge alert', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const now = new Date().toISOString();
    vi.mocked(Alert.findOneAndUpdate).mockResolvedValue({
      _id: 'a1',
      notifiedAt: now,
    } as never);

    const req = makeRequest({ notifiedAt: now }, 'PATCH');
    const res = await PATCH(req, makeParams('a1'));
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid status', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const req = makeRequest({ status: 'invalid' }, 'PATCH');
    const res = await PATCH(req, makeParams('a1'));
    expect(res.status).toBe(400);
  });

  it('returns 404 when not found or not owned', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Alert.findOneAndUpdate).mockResolvedValue(null);

    const req = makeRequest({ status: 'paused' }, 'PATCH');
    const res = await PATCH(req, makeParams('nonexistent'));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/alerts/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest(undefined, 'DELETE');
    const res = await DELETE(req, makeParams('a1'));
    expect(res.status).toBe(401);
  });

  it('deletes owned alert', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Alert.findOneAndDelete).mockResolvedValue({ _id: 'a1' } as never);

    const req = makeRequest(undefined, 'DELETE');
    const res = await DELETE(req, makeParams('a1'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('returns 404 when not found or not owned', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Alert.findOneAndDelete).mockResolvedValue(null);

    const req = makeRequest(undefined, 'DELETE');
    const res = await DELETE(req, makeParams('nonexistent'));
    expect(res.status).toBe(404);
  });
});
