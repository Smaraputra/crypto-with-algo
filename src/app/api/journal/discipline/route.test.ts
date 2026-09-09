import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockAuth = vi.fn();
const mockFind = vi.fn();

vi.mock('@/lib/auth', () => ({ auth: () => mockAuth() }));
vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/models/journal-entry', () => ({
  JournalEntry: { find: (...args: unknown[]) => mockFind(...args) },
}));

import { GET } from './route';

function makeRequest(symbol?: string) {
  const url = symbol
    ? `http://localhost:3000/api/journal/discipline?symbol=${symbol}`
    : 'http://localhost:3000/api/journal/discipline';
  return new NextRequest(url);
}

function mockEntries(entries: unknown[]) {
  mockFind.mockReturnValue({
    sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(entries) }),
  });
}

describe('GET /api/journal/discipline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'user1' } });
  });

  it('returns 401 when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns empty nudges for a clean history', async () => {
    mockEntries([]);
    const res = await GET(makeRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.nudges).toEqual([]);
  });

  it('emits a cooldown warning after consecutive losses', async () => {
    const now = Date.now();
    mockEntries([
      { symbol: 'BTCUSDT', createdAt: new Date(now - 3 * 3600000), updatedAt: new Date(now - 3 * 3600000), outcomePnlPercent: -1 },
      { symbol: 'BTCUSDT', createdAt: new Date(now - 2 * 3600000), updatedAt: new Date(now - 2 * 3600000), outcomePnlPercent: -2 },
      { symbol: 'BTCUSDT', createdAt: new Date(now - 1 * 3600000), updatedAt: new Date(now - 1 * 3600000), outcomePnlPercent: -0.5 },
    ]);

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.nudges.map((n: { rule: string }) => n.rule)).toContain('loss_cooldown');
  });

  it('passes the candidate symbol through for revenge detection', async () => {
    const now = Date.now();
    mockEntries([
      {
        symbol: 'ETHUSDT',
        createdAt: new Date(now - 3600000),
        updatedAt: new Date(now - 10 * 60000),
        outcomePnlPercent: -2,
      },
    ]);

    const res = await GET(makeRequest('ETHUSDT'));
    const data = await res.json();

    expect(data.nudges.map((n: { rule: string }) => n.rule)).toContain('revenge_trade');
  });
});
