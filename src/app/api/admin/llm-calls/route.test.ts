// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));
const mockAuthorize = vi.fn();
vi.mock('./auth', () => ({ authorizeLlmPanel: (...args: unknown[]) => mockAuthorize(...args) }));
const mockCreate = vi.fn();
vi.mock('./create-call', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./create-call')>();
  return { ...actual, createLlmCall: (...args: unknown[]) => mockCreate(...args) };
});
const mockFind = vi.fn();
vi.mock('@/lib/models/llm-call', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/models/llm-call')>();
  return { ...actual, LlmCall: { find: (...args: unknown[]) => mockFind(...args) } };
});

import { GET, POST } from './route';

const validBody = {
  symbol: 'BTCUSDT', interval: '1h', candleTimestamp: 1789689600000, tier: 'buy', strength: 55, confidence: 50,
  rationale: 'ok', votes: [{ role: 'risk_officer', tier: 'buy', strength: 55, note: 'ok' }],
  model: 'claude-sonnet-5', promptVersion: 'v1', inputsHash: 'c'.repeat(64),
};

function post(body: unknown): NextRequest {
  return new NextRequest(new URL('http://localhost/api/admin/llm-calls'), { method: 'POST', body: JSON.stringify(body) });
}
function get(query = ''): NextRequest {
  return new NextRequest(new URL(`http://localhost/api/admin/llm-calls${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthorize.mockResolvedValue({ ok: true, via: 'secret' });
  mockCreate.mockResolvedValue({ call: { _id: 'id1', ...validBody }, created: true });
  const chain = { sort: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue([{ _id: 'id1' }]) };
  mockFind.mockReturnValue(chain);
});

describe('POST /api/admin/llm-calls', () => {
  it('rejects unauthorized and invalid bodies', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, status: 401, body: { error: 'Unauthorized' } });
    expect((await POST(post(validBody))).status).toBe(401);
    mockAuthorize.mockResolvedValue({ ok: true, via: 'secret' });
    expect((await POST(post({ ...validBody, tier: 'long' }))).status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns 201 with created true, 200 on a repeat, and 400 on a freshness failure', async () => {
    expect((await POST(post(validBody))).status).toBe(201);
    mockCreate.mockResolvedValue({ call: { _id: 'id1' }, created: false });
    expect((await POST(post(validBody))).status).toBe(200);
    const { FreshnessError } = await import('./create-call');
    mockCreate.mockRejectedValue(new FreshnessError('stale: bar closed more than 2 intervals ago'));
    const res = await POST(post(validBody));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/stale/);
  });
});

describe('GET /api/admin/llm-calls', () => {
  it('lists newest first with the filters and a capped limit', async () => {
    const res = await GET(get('?symbol=BTCUSDT&interval=1h&limit=500'));
    expect(res.status).toBe(200);
    expect(mockFind).toHaveBeenCalledWith({ symbol: 'BTCUSDT', interval: '1h' });
    const chain = mockFind.mock.results[0].value;
    expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(chain.limit).toHaveBeenCalledWith(200);
  });
});
