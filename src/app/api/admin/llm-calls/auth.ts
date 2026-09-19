import type { NextRequest } from 'next/server';

import { verifyLlmPanelSecret } from '@/lib/cron-auth';
import { requireAdmin, adminAuthError, adminAuthStatus } from '@/lib/admin-auth';

export type LlmPanelAuth =
  | { ok: true; via: 'secret' | 'admin' }
  | { ok: false; status: number; body: { error: string } };

/**
 * The panel skill authenticates with LLM_PANEL_SECRET (a machine caller has
 * no session); a browser with the admin session is accepted too. The secret
 * is checked first so a valid bearer never touches the session store.
 */
export async function authorizeLlmPanel(req: NextRequest): Promise<LlmPanelAuth> {
  if (verifyLlmPanelSecret(req)) return { ok: true, via: 'secret' };

  const admin = await requireAdmin();
  if (admin.ok) return { ok: true, via: 'admin' };

  return { ok: false, status: adminAuthStatus(admin), body: adminAuthError(admin) };
}
