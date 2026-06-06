import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyTurnstile } from './turnstile';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret');
  vi.stubGlobal('fetch', vi.fn());
});

describe('verifyTurnstile', () => {
  it('returns true when Cloudflare reports success', async () => {
    vi.mocked(fetch).mockResolvedValue({ json: async () => ({ success: true }) } as Response);
    expect(await verifyTurnstile('token')).toBe(true);
  });

  it('returns false when Cloudflare reports failure', async () => {
    vi.mocked(fetch).mockResolvedValue({ json: async () => ({ success: false }) } as Response);
    expect(await verifyTurnstile('token')).toBe(false);
  });

  it('returns false for an empty token without calling Cloudflare', async () => {
    expect(await verifyTurnstile('')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips verification (returns true) when the secret is unconfigured', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await verifyTurnstile('token')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
