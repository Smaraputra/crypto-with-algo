// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { GET } from './route';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

const mocks = vi.hoisted(() => ({
  authorizeLlmPanel: vi.fn(),
  countDocuments: vi.fn(),
}));

vi.mock('../auth', () => ({ authorizeLlmPanel: mocks.authorizeLlmPanel }));
vi.mock('@/lib/models/llm-call', () => ({
  LlmCall: { countDocuments: mocks.countDocuments },
  LLM_CALL_INTERVALS: ['1h', '4h', '1d'] as const,
}));

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/admin/llm-calls/count${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeLlmPanel.mockResolvedValue({ ok: true, via: 'secret' });
  mocks.countDocuments.mockResolvedValue(0);
});

describe('GET /api/admin/llm-calls/count', () => {
  it('rejects an unauthorised caller', async () => {
    mocks.authorizeLlmPanel.mockResolvedValue({
      ok: false,
      status: 401,
      body: { error: 'Unauthorized' },
    });

    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(mocks.countDocuments).not.toHaveBeenCalled();
  });

  it('does not clamp a count above the list route\'s 200 cap', async () => {
    // The whole reason this route exists: the list route caps at 200, so the
    // panel's monitor read a flat 200 while 1h actually held 247.
    mocks.countDocuments.mockResolvedValue(247);

    const body = await (await GET(request('?interval=1h'))).json();

    expect(body.count).toBe(247);
  });

  it('counts everything when no filter is given', async () => {
    mocks.countDocuments.mockResolvedValue(407);

    const body = await (await GET(request())).json();

    expect(mocks.countDocuments).toHaveBeenCalledWith({});
    expect(body).toEqual({ count: 407, symbol: null, interval: null, since: null });
  });

  it('filters by symbol and interval', async () => {
    await GET(request('?symbol=BTCUSDT&interval=4h'));

    expect(mocks.countDocuments).toHaveBeenCalledWith({ symbol: 'BTCUSDT', interval: '4h' });
  });

  it('accepts a since window as epoch milliseconds', async () => {
    const since = 1789909200000;

    const body = await (await GET(request(`?since=${since}`))).json();

    expect(mocks.countDocuments).toHaveBeenCalledWith({ createdAt: { $gte: new Date(since) } });
    expect(body.since).toBe(new Date(since).toISOString());
  });

  it('accepts a since window as an ISO date', async () => {
    await GET(request('?since=2026-09-24T00:00:00.000Z'));

    expect(mocks.countDocuments).toHaveBeenCalledWith({
      createdAt: { $gte: new Date('2026-09-24T00:00:00.000Z') },
    });
  });

  it('rejects an unparseable since', async () => {
    const res = await GET(request('?since=yesterday'));

    expect(res.status).toBe(400);
    expect(mocks.countDocuments).not.toHaveBeenCalled();
  });

  it('rejects an unknown interval', async () => {
    const res = await GET(request('?interval=3m'));

    expect(res.status).toBe(400);
  });

  it('rejects a malformed symbol', async () => {
    const res = await GET(request('?symbol=btc'));

    expect(res.status).toBe(400);
  });

  it('returns 500 when the count throws', async () => {
    mocks.countDocuments.mockRejectedValue(new Error('mongo down'));

    const res = await GET(request());

    expect(res.status).toBe(500);
  });
});
