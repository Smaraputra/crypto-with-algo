// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { verifyCronSecret } from './cron-auth';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/test', { headers });
}

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', 'test-secret-123');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('verifyCronSecret', () => {
  it('returns true for valid bearer token', () => {
    const req = makeRequest({ Authorization: 'Bearer test-secret-123' });
    expect(verifyCronSecret(req)).toBe(true);
  });

  it('returns false when CRON_SECRET is not set', () => {
    vi.stubEnv('CRON_SECRET', '');
    const req = makeRequest({ Authorization: 'Bearer test-secret-123' });
    expect(verifyCronSecret(req)).toBe(false);
  });

  it('returns false when authorization header is missing', () => {
    const req = makeRequest();
    expect(verifyCronSecret(req)).toBe(false);
  });

  it('returns false for wrong secret', () => {
    const req = makeRequest({ Authorization: 'Bearer wrong-secret' });
    expect(verifyCronSecret(req)).toBe(false);
  });

  it('returns false for missing Bearer prefix', () => {
    const req = makeRequest({ Authorization: 'test-secret-123' });
    expect(verifyCronSecret(req)).toBe(false);
  });

  it('returns false for length mismatch (prevents timing attack)', () => {
    const req = makeRequest({ Authorization: 'Bearer short' });
    expect(verifyCronSecret(req)).toBe(false);
  });

  it('uses constant-time comparison (same length, wrong content)', () => {
    // Same length as 'Bearer test-secret-123' but different content
    const req = makeRequest({ Authorization: 'Bearer test-secret-999' });
    expect(verifyCronSecret(req)).toBe(false);
  });
});
