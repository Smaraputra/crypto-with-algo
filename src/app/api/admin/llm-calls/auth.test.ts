// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockAuth = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: () => mockAuth() }));

import { authorizeLlmPanel } from './auth';

function req(secret?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (secret) headers.authorization = `Bearer ${secret}`;
  return new NextRequest(new URL('http://localhost/api/admin/llm-calls'), { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LLM_PANEL_SECRET', 'panel-secret');
  vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
  mockAuth.mockResolvedValue(null);
});

describe('authorizeLlmPanel', () => {
  it('passes on the bearer secret without consulting the session', async () => {
    expect(await authorizeLlmPanel(req('panel-secret'))).toEqual({ ok: true, via: 'secret' });
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('passes on an admin session when the bearer is absent', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    expect(await authorizeLlmPanel(req())).toEqual({ ok: true, via: 'admin' });
  });

  it('returns 401 with neither, and 500 when the admin email is not configured and no secret matched', async () => {
    expect(await authorizeLlmPanel(req('wrong'))).toEqual({ ok: false, status: 401, body: { error: 'Unauthorized' } });
    vi.stubEnv('ADMIN_EMAIL', '');
    expect((await authorizeLlmPanel(req())).ok).toBe(false);
  });
});
