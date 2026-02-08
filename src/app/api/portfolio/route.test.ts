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
    find: vi.fn(),
    findOne: vi.fn(),
    create: vi.fn(),
  },
}));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { Portfolio } from '@/lib/models/portfolio';

function makeRequest(body?: unknown): NextRequest {
  if (body === undefined) {
    return new NextRequest('http://localhost/api/portfolio', { method: 'GET' });
  }
  return new NextRequest('http://localhost/api/portfolio', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const mockSession = { user: { id: 'user-1' } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/portfolio', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns portfolios array', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const mockFind = vi.mocked(Portfolio.find);
    mockFind.mockReturnValue({
      sort: vi.fn().mockResolvedValue([
        {
          _id: 'p1',
          name: 'My Portfolio',
          holdings: [{ symbol: 'BTCUSDT' }],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    } as never);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.portfolios).toHaveLength(1);
    expect(data.portfolios[0].name).toBe('My Portfolio');
    expect(data.portfolios[0].holdingsCount).toBe(1);
  });

  it('auto-creates default portfolio when none exist', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const mockFind = vi.mocked(Portfolio.find);
    mockFind.mockReturnValue({
      sort: vi.fn().mockResolvedValue([]),
    } as never);
    vi.mocked(Portfolio.create).mockResolvedValue({
      _id: 'p1',
      name: 'My Portfolio',
      holdings: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.portfolios).toHaveLength(1);
    expect(data.portfolios[0].name).toBe('My Portfolio');
    expect(Portfolio.create).toHaveBeenCalledWith({ userId: 'user-1' });
  });
});

describe('POST /api/portfolio', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest({ name: 'Test' });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('creates portfolio with name and returns 201', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue(null);
    vi.mocked(Portfolio.create).mockResolvedValue({
      _id: 'p1',
      name: 'Trading',
      holdings: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const req = makeRequest({ name: 'Trading' });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.portfolio.name).toBe('Trading');
    expect(data.portfolio.holdingsCount).toBe(0);
  });

  it('returns 400 for missing name', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const req = makeRequest({});
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty name', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const req = makeRequest({ name: '' });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 409 for duplicate name', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Portfolio.findOne).mockResolvedValue({ _id: 'existing' } as never);

    const req = makeRequest({ name: 'My Portfolio' });
    const res = await POST(req);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain('already exists');
  });
});
