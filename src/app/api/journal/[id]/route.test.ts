// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/models/journal-entry', () => ({
  JournalEntry: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findOneAndDelete: vi.fn(),
  },
}));

import { GET, PATCH, DELETE } from './route';
import { auth } from '@/lib/auth';
import { JournalEntry } from '@/lib/models/journal-entry';

const mockSession = { user: { id: 'user-1' } };
const params = Promise.resolve({ id: 'journal-1' });

function makeRequest(method: string, body?: unknown): NextRequest {
  if (body) {
    return new NextRequest('http://localhost/api/journal/journal-1', {
      method,
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new NextRequest('http://localhost/api/journal/journal-1', { method });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/journal/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeRequest('GET'), { params });
    expect(res.status).toBe(401);
  });

  it('returns entry', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.findOne).mockResolvedValue({
      _id: 'journal-1',
      symbol: 'BTCUSDT',
    } as never);

    const res = await GET(makeRequest('GET'), { params });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entry.symbol).toBe('BTCUSDT');
  });

  it('returns 404 when not found', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.findOne).mockResolvedValue(null);

    const res = await GET(makeRequest('GET'), { params });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/journal/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await PATCH(makeRequest('PATCH', { notes: 'updated' }), { params });
    expect(res.status).toBe(401);
  });

  it('updates entry', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.findOneAndUpdate).mockResolvedValue({
      _id: 'journal-1',
      notes: 'updated',
    } as never);

    const res = await PATCH(makeRequest('PATCH', { notes: 'updated' }), { params });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entry.notes).toBe('updated');
  });

  it('returns 404 when not found', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.findOneAndUpdate).mockResolvedValue(null);

    const res = await PATCH(makeRequest('PATCH', { notes: 'updated' }), { params });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid update', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await PATCH(makeRequest('PATCH', { exitPrice: -100 }), { params });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/journal/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await DELETE(makeRequest('DELETE'), { params });
    expect(res.status).toBe(401);
  });

  it('deletes entry', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.findOneAndDelete).mockResolvedValue({ _id: 'journal-1' } as never);

    const res = await DELETE(makeRequest('DELETE'), { params });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('returns 404 when not found', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.findOneAndDelete).mockResolvedValue(null);

    const res = await DELETE(makeRequest('DELETE'), { params });
    expect(res.status).toBe(404);
  });
});
