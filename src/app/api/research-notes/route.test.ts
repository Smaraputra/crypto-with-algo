// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/models/research-note', () => ({
  ResearchNote: {
    find: vi.fn(),
    countDocuments: vi.fn(),
    create: vi.fn(),
  },
  MAX_RESEARCH_NOTES_PER_USER: 200,
}));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { ResearchNote } from '@/lib/models/research-note';
import { mockCreateResearchNoteInput } from '@/__fixtures__/research-notes';

const mockSession = { user: { id: 'user-1' } };

function mockFindChain(notes: unknown[] = []) {
  vi.mocked(ResearchNote.find).mockReturnValue({
    sort: vi.fn().mockReturnValue({
      skip: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(notes),
      }),
    }),
  } as never);
}

function makeGetRequest(params?: string): NextRequest {
  const url = params
    ? `http://localhost/api/research-notes?${params}`
    : 'http://localhost/api/research-notes';
  return new NextRequest(url);
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/research-notes', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/research-notes', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it('returns notes with pagination', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockFindChain([{ _id: 'rn-1', title: 'Test' }]);
    vi.mocked(ResearchNote.countDocuments).mockResolvedValue(1 as never);

    const res = await GET(makeGetRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.notes).toHaveLength(1);
    expect(data.total).toBe(1);
    expect(data.page).toBe(1);
    expect(data.totalPages).toBe(1);
  });

  it('filters by category', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockFindChain([]);
    vi.mocked(ResearchNote.countDocuments).mockResolvedValue(0 as never);

    await GET(makeGetRequest('category=strategy'));

    expect(ResearchNote.find).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'strategy' })
    );
  });

  it('filters by tag', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockFindChain([]);
    vi.mocked(ResearchNote.countDocuments).mockResolvedValue(0 as never);

    await GET(makeGetRequest('tag=breakout'));

    expect(ResearchNote.find).toHaveBeenCalledWith(
      expect.objectContaining({ tags: 'breakout' })
    );
  });

  it('filters by search', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockFindChain([]);
    vi.mocked(ResearchNote.countDocuments).mockResolvedValue(0 as never);

    await GET(makeGetRequest('search=breakout'));

    expect(ResearchNote.find).toHaveBeenCalledWith(
      expect.objectContaining({ title: { $regex: expect.stringContaining('breakout'), $options: 'i' } })
    );
  });

  it('filters by pinned', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockFindChain([]);
    vi.mocked(ResearchNote.countDocuments).mockResolvedValue(0 as never);

    await GET(makeGetRequest('pinned=true'));

    expect(ResearchNote.find).toHaveBeenCalledWith(
      expect.objectContaining({ isPinned: true })
    );
  });

  it('clamps limit to 50', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockFindChain([]);
    vi.mocked(ResearchNote.countDocuments).mockResolvedValue(0 as never);

    await GET(makeGetRequest('limit=100'));

    const findCall = vi.mocked(ResearchNote.find).mock.results[0];
    const sortReturn = (findCall.value as { sort: ReturnType<typeof vi.fn> }).sort.mock.results[0];
    const skipReturn = (sortReturn.value as { skip: ReturnType<typeof vi.fn> }).skip.mock.results[0];
    expect((skipReturn.value as { limit: ReturnType<typeof vi.fn> }).limit).toHaveBeenCalledWith(50);
  });
});

describe('POST /api/research-notes', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(makePostRequest(mockCreateResearchNoteInput));
    expect(res.status).toBe(401);
  });

  it('creates a note', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(ResearchNote.countDocuments).mockResolvedValue(0 as never);
    const created = { _id: 'rn-new', ...mockCreateResearchNoteInput };
    vi.mocked(ResearchNote.create).mockResolvedValue(created as never);

    const res = await POST(makePostRequest(mockCreateResearchNoteInput));
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.note._id).toBe('rn-new');
  });

  it('returns 400 for invalid input', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const res = await POST(makePostRequest({ title: '' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 at max notes limit', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(ResearchNote.countDocuments).mockResolvedValue(200 as never);

    const res = await POST(makePostRequest(mockCreateResearchNoteInput));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain('200');
  });
});
