// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.fn();

vi.mock('@/lib/auth', () => ({
  auth: () => mockAuth(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

const mockUpdateOne = vi.fn();
vi.mock('@/lib/models/user', () => ({
  User: {
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

import { POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/auth/consent', () => {
  it('returns 401 if not authenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 401 if session has no user id', async () => {
    mockAuth.mockResolvedValue({ user: {} });
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it('records consent for authenticated user', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-123' } });
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    const res = await POST();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'user-123', tosAcceptedAt: { $exists: false } },
      { $set: { tosAcceptedAt: expect.any(Date) } }
    );
  });

  it('returns 500 on database error', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-123' } });
    mockUpdateOne.mockRejectedValue(new Error('DB error'));

    const res = await POST();
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Internal server error');
  });
});
