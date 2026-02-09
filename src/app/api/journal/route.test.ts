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
    find: vi.fn(),
    countDocuments: vi.fn(),
    create: vi.fn(),
  },
  MAX_JOURNAL_ENTRIES_PER_USER: 500,
}));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { JournalEntry } from '@/lib/models/journal-entry';
import { mockCreateJournalInput } from '@/__fixtures__/journal';

const mockSession = { user: { id: 'user-1' } };

function makeGetRequest(params?: string): NextRequest {
  const url = params
    ? `http://localhost/api/journal?${params}`
    : 'http://localhost/api/journal';
  return new NextRequest(url);
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/journal', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/journal', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it('returns journal entries for user', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.find).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{ _id: 'j1', symbol: 'BTCUSDT' }]),
      }),
    } as never);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toHaveLength(1);
    expect(JournalEntry.find).toHaveBeenCalledWith({ userId: 'user-1' });
  });

  it('filters by symbol when provided', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.find).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    await GET(makeGetRequest('symbol=ETHUSDT'));
    expect(JournalEntry.find).toHaveBeenCalledWith({
      userId: 'user-1',
      symbol: 'ETHUSDT',
    });
  });
});

describe('POST /api/journal', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(makePostRequest(mockCreateJournalInput));
    expect(res.status).toBe(401);
  });

  it('creates a journal entry', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);
    vi.mocked(JournalEntry.create).mockResolvedValue({
      _id: 'j1',
      userId: 'user-1',
      ...mockCreateJournalInput,
    } as never);

    const res = await POST(makePostRequest(mockCreateJournalInput));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.entry.symbol).toBe('BTCUSDT');
  });

  it('returns 400 for invalid input', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await POST(makePostRequest({ symbol: '' }));
    expect(res.status).toBe(400);
  });

  it('enforces entry limit', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(500);

    const res = await POST(makePostRequest(mockCreateJournalInput));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Maximum of 500');
  });
});
