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
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findOneAndDelete: vi.fn(),
  },
}));

import { GET, PATCH, DELETE } from './route';
import { auth } from '@/lib/auth';
import { ResearchNote } from '@/lib/models/research-note';

const mockSession = { user: { id: 'user-1' } };
const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/research-notes/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(
      new NextRequest('http://localhost/api/research-notes/rn-1'),
      makeParams('rn-1')
    );
    expect(res.status).toBe(401);
  });

  it('returns note', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(ResearchNote.findOne).mockResolvedValue({
      _id: 'rn-1',
      title: 'Test',
    } as never);

    const res = await GET(
      new NextRequest('http://localhost/api/research-notes/rn-1'),
      makeParams('rn-1')
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.note._id).toBe('rn-1');
  });

  it('returns 404 for missing note', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(ResearchNote.findOne).mockResolvedValue(null as never);

    const res = await GET(
      new NextRequest('http://localhost/api/research-notes/rn-missing'),
      makeParams('rn-missing')
    );
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/research-notes/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const req = new NextRequest('http://localhost/api/research-notes/rn-1', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Updated' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PATCH(req, makeParams('rn-1'));
    expect(res.status).toBe(401);
  });

  it('updates a note', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(ResearchNote.findOneAndUpdate).mockResolvedValue({
      _id: 'rn-1',
      title: 'Updated',
    } as never);

    const req = new NextRequest('http://localhost/api/research-notes/rn-1', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Updated' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PATCH(req, makeParams('rn-1'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.note.title).toBe('Updated');
  });

  it('returns 400 for invalid input', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);

    const req = new NextRequest('http://localhost/api/research-notes/rn-1', {
      method: 'PATCH',
      body: JSON.stringify({ category: 'invalid' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PATCH(req, makeParams('rn-1'));
    expect(res.status).toBe(400);
  });

  it('returns 404 for missing note', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(ResearchNote.findOneAndUpdate).mockResolvedValue(null as never);

    const req = new NextRequest('http://localhost/api/research-notes/rn-1', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Updated' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PATCH(req, makeParams('rn-1'));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/research-notes/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await DELETE(
      new NextRequest('http://localhost/api/research-notes/rn-1', { method: 'DELETE' }),
      makeParams('rn-1')
    );
    expect(res.status).toBe(401);
  });

  it('deletes a note', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(ResearchNote.findOneAndDelete).mockResolvedValue({ _id: 'rn-1' } as never);

    const res = await DELETE(
      new NextRequest('http://localhost/api/research-notes/rn-1', { method: 'DELETE' }),
      makeParams('rn-1')
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
  });

  it('returns 404 for missing note', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(ResearchNote.findOneAndDelete).mockResolvedValue(null as never);

    const res = await DELETE(
      new NextRequest('http://localhost/api/research-notes/rn-1', { method: 'DELETE' }),
      makeParams('rn-1')
    );
    expect(res.status).toBe(404);
  });
});
