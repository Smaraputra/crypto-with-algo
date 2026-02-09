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
    find: vi.fn(),
    countDocuments: vi.fn(),
    create: vi.fn(),
  },
  MAX_STRATEGIES_PER_USER: 5,
}));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { Strategy } from '@/lib/models/strategy';
import { mockCreateStrategyInput } from '@/__fixtures__/strategies';

const mockSession = { user: { id: 'user-1' } };

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/strategies', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/strategies', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns strategies for user', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Strategy.find).mockReturnValue({
      sort: vi.fn().mockResolvedValue([
        { _id: 's1', name: 'Test', userId: 'user-1' },
      ]),
    } as never);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.strategies).toHaveLength(1);
    expect(Strategy.find).toHaveBeenCalledWith({ userId: 'user-1' });
  });
});

describe('POST /api/strategies', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(makePostRequest(mockCreateStrategyInput));
    expect(res.status).toBe(401);
  });

  it('creates a strategy', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Strategy.countDocuments).mockResolvedValue(0);
    vi.mocked(Strategy.create).mockResolvedValue({
      _id: 's1',
      userId: 'user-1',
      ...mockCreateStrategyInput,
    } as never);

    const res = await POST(makePostRequest(mockCreateStrategyInput));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.strategy.name).toBe('New Strategy');
  });

  it('returns 400 for invalid input', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await POST(makePostRequest({ name: '' }));
    expect(res.status).toBe(400);
  });

  it('enforces 5-strategy limit', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(Strategy.countDocuments).mockResolvedValue(5);

    const res = await POST(makePostRequest(mockCreateStrategyInput));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Maximum of 5');
  });
});
