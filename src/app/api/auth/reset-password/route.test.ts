// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/models/user', () => ({ User: { updateOne: vi.fn() } }));
vi.mock('@/lib/auth-tokens', () => ({ consumeToken: vi.fn() }));
vi.mock('bcryptjs', () => ({ default: { hash: vi.fn(async () => 'hashed') } }));
vi.mock('@/lib/rate-limit', () => ({ createRateLimiter: vi.fn(() => 'l'), rateLimit: vi.fn(() => null) }));

import { POST } from './route';
import { User } from '@/lib/models/user';
import { consumeToken } from '@/lib/auth-tokens';
import bcrypt from 'bcryptjs';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/auth/reset-password', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => vi.clearAllMocks());

describe('POST /api/auth/reset-password', () => {
  it('sets a new hashed password and marks emailVerified for a valid token', async () => {
    vi.mocked(consumeToken).mockResolvedValue('u1');
    const res = await POST(makeRequest({ token: 'good', password: 'Secret1!' }));
    expect(res.status).toBe(200);
    expect(bcrypt.hash).toHaveBeenCalledWith('Secret1!', 12);
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: 'u1' },
      { $set: { password: 'hashed', emailVerified: expect.any(Date) } }
    );
  });

  it('returns 400 for an invalid or expired token', async () => {
    vi.mocked(consumeToken).mockResolvedValue(null);
    const res = await POST(makeRequest({ token: 'bad', password: 'Secret1!' }));
    expect(res.status).toBe(400);
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it('returns 400 for a weak password before consuming the token', async () => {
    const res = await POST(makeRequest({ token: 'good', password: 'weak' }));
    expect(res.status).toBe(400);
    expect(consumeToken).not.toHaveBeenCalled();
  });
});
