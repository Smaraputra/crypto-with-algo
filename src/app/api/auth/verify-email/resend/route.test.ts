// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/models/user', () => ({ User: { findOne: vi.fn() } }));
vi.mock('@/lib/auth-tokens', () => ({ createToken: vi.fn() }));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/turnstile', () => ({ verifyTurnstile: vi.fn(() => true) }));
vi.mock('@/lib/rate-limit', () => ({ createRateLimiter: vi.fn(() => 'l'), rateLimit: vi.fn(() => null) }));

import { POST } from './route';
import { User } from '@/lib/models/user';
import { createToken } from '@/lib/auth-tokens';
import { sendEmail } from '@/lib/email/mailer';
import { verifyTurnstile } from '@/lib/turnstile';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/auth/verify-email/resend', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyTurnstile).mockResolvedValue(true);
});

describe('POST /api/auth/verify-email/resend', () => {
  it('returns 200 and sends mail for an existing unverified user', async () => {
    vi.mocked(User.findOne).mockResolvedValue({ _id: { toString: () => 'u1' }, name: 'A', email: 'a@b.com', emailVerified: undefined });
    vi.mocked(createToken).mockResolvedValue('rawtoken');
    const res = await POST(makeRequest({ email: 'a@b.com', turnstileToken: 'ok' }));
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('returns 200 without sending for an unknown email (no enumeration)', async () => {
    vi.mocked(User.findOne).mockResolvedValue(null);
    const res = await POST(makeRequest({ email: 'nobody@b.com', turnstileToken: 'ok' }));
    expect(res.status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('returns 200 without sending for an already-verified user', async () => {
    vi.mocked(User.findOne).mockResolvedValue({ _id: { toString: () => 'u1' }, name: 'A', email: 'a@b.com', emailVerified: new Date() });
    const res = await POST(makeRequest({ email: 'a@b.com', turnstileToken: 'ok' }));
    expect(res.status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('returns 400 when Turnstile fails', async () => {
    vi.mocked(verifyTurnstile).mockResolvedValue(false);
    const res = await POST(makeRequest({ email: 'a@b.com', turnstileToken: 'bad' }));
    expect(res.status).toBe(400);
  });
});
