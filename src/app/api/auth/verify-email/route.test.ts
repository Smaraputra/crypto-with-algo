// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/models/user', () => ({ User: { updateOne: vi.fn() } }));
vi.mock('@/lib/auth-tokens', () => ({ consumeToken: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ createRateLimiter: vi.fn(() => 'l'), rateLimit: vi.fn(() => null) }));

import { POST } from './route';
import { User } from '@/lib/models/user';
import { consumeToken } from '@/lib/auth-tokens';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/auth/verify-email', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => vi.clearAllMocks());

describe('POST /api/auth/verify-email', () => {
  it('sets emailVerified when the token is valid', async () => {
    vi.mocked(consumeToken).mockResolvedValue('u1');
    const res = await POST(makeRequest({ token: 'good' }));
    expect(res.status).toBe(200);
    expect(consumeToken).toHaveBeenCalledWith('good', 'verify');
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: 'u1' }, { $set: { emailVerified: expect.any(Date) } }
    );
  });

  it('returns 400 for an invalid or expired token', async () => {
    vi.mocked(consumeToken).mockResolvedValue(null);
    const res = await POST(makeRequest({ token: 'bad' }));
    expect(res.status).toBe(400);
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it('returns 400 when token is missing', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });
});
