import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requireAdmin, adminAuthStatus, adminAuthError } from './admin-auth';

const mockAuth = vi.fn();
vi.mock('@/lib/auth', () => ({
  auth: () => mockAuth(),
}));

describe('requireAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.ADMIN_EMAIL;
    vi.restoreAllMocks();
  });

  it('authorizes the configured admin email', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const result = await requireAdmin();

    expect(result).toEqual({ ok: true, email: 'admin@example.com' });
  });

  it('rejects a signed-in non-admin as unauthorized', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'someone@example.com' } });

    const result = await requireAdmin();

    expect(result).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('rejects an unauthenticated request as unauthorized', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue(null);

    const result = await requireAdmin();

    expect(result).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('reports an unset ADMIN_EMAIL as not-configured, not unauthorized', async () => {
    delete process.env.ADMIN_EMAIL;
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const result = await requireAdmin();

    expect(result).toEqual({ ok: false, reason: 'not-configured' });
  });

  it('does not consult the session when ADMIN_EMAIL is unset', async () => {
    delete process.env.ADMIN_EMAIL;

    await requireAdmin();

    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('logs the misconfiguration so it is diagnosable from container logs', async () => {
    delete process.env.ADMIN_EMAIL;

    await requireAdmin();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('ADMIN_EMAIL is not configured')
    );
  });

  it('treats an empty-string ADMIN_EMAIL as unset', async () => {
    process.env.ADMIN_EMAIL = '';
    mockAuth.mockResolvedValue({ user: { email: '' } });

    const result = await requireAdmin();

    expect(result).toEqual({ ok: false, reason: 'not-configured' });
  });
});

describe('adminAuthStatus / adminAuthError', () => {
  it('maps a misconfiguration to 500 so it is not mistaken for a permissions denial', () => {
    const failure = { ok: false, reason: 'not-configured' } as const;

    expect(adminAuthStatus(failure)).toBe(500);
    expect(adminAuthError(failure)).toEqual({ error: 'Admin access is not configured' });
  });

  it('maps a denied user to 401', () => {
    const failure = { ok: false, reason: 'unauthorized' } as const;

    expect(adminAuthStatus(failure)).toBe(401);
    expect(adminAuthError(failure)).toEqual({ error: 'Unauthorized' });
  });
});
