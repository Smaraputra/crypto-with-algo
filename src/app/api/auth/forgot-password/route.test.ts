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
  return new NextRequest('http://localhost/api/auth/forgot-password', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyTurnstile).mockResolvedValue(true);
});

describe('POST /api/auth/forgot-password', () => {
  it('returns 200 and emails a reset link for an existing credentials user', async () => {
    vi.mocked(User.findOne).mockResolvedValue({ _id: { toString: () => 'u1' }, name: 'A', email: 'a@b.com', password: 'hash' });
    vi.mocked(createToken).mockResolvedValue('rawtoken');
    const res = await POST(makeRequest({ email: 'a@b.com', turnstileToken: 'ok' }));
    expect(res.status).toBe(200);
    expect(createToken).toHaveBeenCalledWith('u1', 'reset', 3600);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(sendEmail).mock.calls[0][0];
    expect(sent.to).toBe('a@b.com');
    expect(sent.html).toContain('/reset-password?token=rawtoken');
  });

  it('returns 200 without sending for an unknown email (no enumeration)', async () => {
    vi.mocked(User.findOne).mockResolvedValue(null);
    const res = await POST(makeRequest({ email: 'nobody@b.com', turnstileToken: 'ok' }));
    expect(res.status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('returns 200 without sending for an OAuth-only user (no password)', async () => {
    vi.mocked(User.findOne).mockResolvedValue({ _id: { toString: () => 'u1' }, name: 'A', email: 'a@b.com', password: undefined });
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
