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
    vi.mocked(JournalEntry.findOne).mockResolvedValue({
      _id: 'journal-1',
      lessonsLearned: '',
      reviewedAt: null,
    } as never);
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
    vi.mocked(JournalEntry.findOne).mockResolvedValue(null);

    const res = await PATCH(makeRequest('PATCH', { notes: 'updated' }), { params });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid update', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await PATCH(makeRequest('PATCH', { exitPrice: -100 }), { params });
    expect(res.status).toBe(400);
  });

  it('auto-computes P&L for buy action', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.findOne).mockResolvedValue({
      _id: 'journal-1',
      entryPrice: 40000,
      action: 'buy',
    } as never);
    vi.mocked(JournalEntry.findOneAndUpdate).mockResolvedValue({
      _id: 'journal-1',
      exitPrice: 44000,
      outcomePnlPercent: 10,
    } as never);

    await PATCH(makeRequest('PATCH', { exitPrice: 44000 }), { params });
    expect(JournalEntry.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'journal-1', userId: 'user-1' },
      expect.objectContaining({ outcomePnlPercent: 10 }),
      { new: true }
    );
  });

  it('auto-computes P&L for sell action (inverted)', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.findOne).mockResolvedValue({
      _id: 'journal-1',
      entryPrice: 2200,
      action: 'sell',
    } as never);
    vi.mocked(JournalEntry.findOneAndUpdate).mockResolvedValue({
      _id: 'journal-1',
      exitPrice: 2100,
      outcomePnlPercent: expect.any(Number),
    } as never);

    await PATCH(makeRequest('PATCH', { exitPrice: 2100 }), { params });
    expect(JournalEntry.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'journal-1', userId: 'user-1' },
      expect.objectContaining({
        outcomePnlPercent: expect.closeTo(4.545, 2),
      }),
      { new: true }
    );
  });

  it('returns 400 when setting exitPrice on entry without entryPrice', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.findOne).mockResolvedValue({
      _id: 'journal-1',
      entryPrice: null,
      action: 'buy',
    } as never);

    const res = await PATCH(makeRequest('PATCH', { exitPrice: 44000 }), { params });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('entry price');
    expect(JournalEntry.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('does not compute P&L for hold action', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.findOne).mockResolvedValue({
      _id: 'journal-1',
      entryPrice: 40000,
      action: 'hold',
    } as never);
    vi.mocked(JournalEntry.findOneAndUpdate).mockResolvedValue({
      _id: 'journal-1',
      exitPrice: 44000,
    } as never);

    await PATCH(makeRequest('PATCH', { exitPrice: 44000 }), { params });
    expect(JournalEntry.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'journal-1', userId: 'user-1' },
      expect.not.objectContaining({ outcomePnlPercent: expect.anything() }),
      { new: true }
    );
  });

  it('does not compute P&L for skip action', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.findOne).mockResolvedValue({
      _id: 'journal-1',
      entryPrice: 40000,
      action: 'skip',
    } as never);
    vi.mocked(JournalEntry.findOneAndUpdate).mockResolvedValue({
      _id: 'journal-1',
      exitPrice: 44000,
    } as never);

    await PATCH(makeRequest('PATCH', { exitPrice: 44000 }), { params });
    expect(JournalEntry.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'journal-1', userId: 'user-1' },
      expect.not.objectContaining({ outcomePnlPercent: expect.anything() }),
      { new: true }
    );
  });

  it('pushes previous review to reviewHistory when updating lessonsLearned', async () => {
    const existingReviewedAt = new Date('2025-01-15T00:00:00Z');
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.findOne).mockResolvedValue({
      _id: 'journal-1',
      lessonsLearned: 'First review',
      reviewedAt: existingReviewedAt,
    } as never);
    vi.mocked(JournalEntry.findOneAndUpdate).mockResolvedValue({
      _id: 'journal-1',
      lessonsLearned: 'Second review',
      reviewHistory: [{ lessonsLearned: 'First review', reviewedAt: existingReviewedAt }],
    } as never);

    const res = await PATCH(
      makeRequest('PATCH', { lessonsLearned: 'Second review', reviewedAt: new Date().toISOString() }),
      { params }
    );
    expect(res.status).toBe(200);
    expect(JournalEntry.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'journal-1', userId: 'user-1' },
      {
        $set: expect.objectContaining({ lessonsLearned: 'Second review' }),
        $push: {
          reviewHistory: {
            lessonsLearned: 'First review',
            reviewedAt: existingReviewedAt,
          },
        },
      },
      { new: true }
    );
  });

  it('does not push reviewHistory on first review', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.findOne).mockResolvedValue({
      _id: 'journal-1',
      lessonsLearned: '',
      reviewedAt: null,
    } as never);
    vi.mocked(JournalEntry.findOneAndUpdate).mockResolvedValue({
      _id: 'journal-1',
      lessonsLearned: 'First review',
    } as never);

    await PATCH(
      makeRequest('PATCH', { lessonsLearned: 'First review', reviewedAt: new Date().toISOString() }),
      { params }
    );
    // Should use simple update, not $set/$push
    expect(JournalEntry.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'journal-1', userId: 'user-1' },
      expect.objectContaining({ lessonsLearned: 'First review' }),
      { new: true }
    );
    // Verify no $push was used
    const updateArg = vi.mocked(JournalEntry.findOneAndUpdate).mock.calls[0][1] as Record<string, unknown>;
    expect(updateArg.$push).toBeUndefined();
  });

  it('updates new fields (tags, lessonsLearned)', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.findOne).mockResolvedValue({
      _id: 'journal-1',
      lessonsLearned: '',
      reviewedAt: null,
    } as never);
    vi.mocked(JournalEntry.findOneAndUpdate).mockResolvedValue({
      _id: 'journal-1',
      tags: ['breakout'],
      lessonsLearned: 'Good timing',
    } as never);

    const res = await PATCH(
      makeRequest('PATCH', {
        tags: ['breakout'],
        lessonsLearned: 'Good timing',
      }),
      { params }
    );
    expect(res.status).toBe(200);
    expect(JournalEntry.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'journal-1', userId: 'user-1' },
      expect.objectContaining({
        tags: ['breakout'],
        lessonsLearned: 'Good timing',
      }),
      { new: true }
    );
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
