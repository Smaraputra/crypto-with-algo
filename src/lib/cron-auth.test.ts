// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { verifyCronSecret, verifyLlmPanelSecret } from './cron-auth';

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

describe('verifyLlmPanelSecret', () => {
  it('accepts the exact LLM_PANEL_SECRET bearer and rejects wrong, missing, and unset', () => {
    vi.stubEnv('LLM_PANEL_SECRET', 'panel-secret');
    expect(verifyLlmPanelSecret(makeRequest({ Authorization: 'Bearer panel-secret' }))).toBe(true);
    expect(verifyLlmPanelSecret(makeRequest({ Authorization: 'Bearer other' }))).toBe(false);
    expect(verifyLlmPanelSecret(makeRequest())).toBe(false);
    vi.stubEnv('LLM_PANEL_SECRET', '');
    expect(verifyLlmPanelSecret(makeRequest({ Authorization: 'Bearer panel-secret' }))).toBe(false);
  });

  it('does not accept CRON_SECRET for the panel', () => {
    vi.stubEnv('CRON_SECRET', 'cron-secret');
    vi.stubEnv('LLM_PANEL_SECRET', 'panel-secret');
    expect(verifyLlmPanelSecret(makeRequest({ Authorization: 'Bearer cron-secret' }))).toBe(false);
  });

  it('logs once when LLM_PANEL_SECRET is unset, and not when it is set but the header is wrong', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.stubEnv('LLM_PANEL_SECRET', '');
    expect(verifyLlmPanelSecret(makeRequest({ Authorization: 'Bearer panel-secret' }))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockClear();
    vi.stubEnv('LLM_PANEL_SECRET', 'panel-secret');
    expect(verifyLlmPanelSecret(makeRequest({ Authorization: 'Bearer wrong' }))).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });
});
