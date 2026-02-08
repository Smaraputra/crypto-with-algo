// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/models/portfolio', () => ({
  Portfolio: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findOneAndDelete: vi.fn(),
  },
}));

import { GET, PATCH, DELETE } from './route';
import { auth } from '@/lib/auth';
import { Portfolio } from '@/lib/models/portfolio';

const mockSession = { user: { id: 'user-1' } };
const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });

function makeRequest(body?: unknown, method = 'GET'): NextRequest {
  if (body === undefined) {
    return new NextRequest('http://localhost/api/portfolio/p1', { method });
  }
  return new NextRequest('http://localhost/api/portfolio/p1', {
    method,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/portfolio/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET(makeRequest(), makeParams('p1'));
    expect(res.status).toBe(401);
  });

  it('returns full portfolio with holdings', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue({
      _id: 'p1',
      userId: 'user-1',
      name: 'My Portfolio',
      holdings: [{ symbol: 'BTCUSDT', quantity: 0.5 }],
    } as never);

    const res = await GET(makeRequest(), makeParams('p1'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.portfolio.name).toBe('My Portfolio');
    expect(data.portfolio.holdings).toHaveLength(1);
  });

  it('returns 404 when not found or not owned', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue(null);

    const res = await GET(makeRequest(), makeParams('nonexistent'));
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/portfolio/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest({ name: 'New Name' }, 'PATCH');
    const res = await PATCH(req, makeParams('p1'));
    expect(res.status).toBe(401);
  });

  it('renames portfolio', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue(null);
    vi.mocked(Portfolio.findOneAndUpdate).mockResolvedValue({
      _id: 'p1',
      name: 'Renamed',
      holdings: [],
    } as never);

    const req = makeRequest({ name: 'Renamed' }, 'PATCH');
    const res = await PATCH(req, makeParams('p1'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.portfolio.name).toBe('Renamed');
  });

  it('returns 400 for invalid name', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const req = makeRequest({ name: '' }, 'PATCH');
    const res = await PATCH(req, makeParams('p1'));
    expect(res.status).toBe(400);
  });

  it('returns 409 for duplicate name', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue({ _id: 'p2' } as never);

    const req = makeRequest({ name: 'Existing' }, 'PATCH');
    const res = await PATCH(req, makeParams('p1'));
    expect(res.status).toBe(409);
  });

  it('returns 404 when portfolio not found', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue(null);
    vi.mocked(Portfolio.findOneAndUpdate).mockResolvedValue(null);

    const req = makeRequest({ name: 'Valid' }, 'PATCH');
    const res = await PATCH(req, makeParams('nonexistent'));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/portfolio/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest(undefined, 'DELETE');
    const res = await DELETE(req, makeParams('p1'));
    expect(res.status).toBe(401);
  });

  it('deletes owned portfolio', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOneAndDelete).mockResolvedValue({ _id: 'p1' } as never);

    const req = makeRequest(undefined, 'DELETE');
    const res = await DELETE(req, makeParams('p1'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('returns 404 when not found or not owned', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOneAndDelete).mockResolvedValue(null);

    const req = makeRequest(undefined, 'DELETE');
    const res = await DELETE(req, makeParams('nonexistent'));
    expect(res.status).toBe(404);
  });
});
