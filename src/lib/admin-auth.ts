/**
 * Shared admin authorization.
 *
 * The same email comparison used to be inlined at every admin call site, which
 * made an unset ADMIN_EMAIL indistinguishable from an unauthorized user: the
 * comparison against `undefined` always fails, so a misconfigured deployment
 * returned a plain 401 and looked like a permissions problem. This helper keeps
 * the two apart so a config gap surfaces as a config gap.
 *
 * Callers shape their own response (routes return JSON, pages redirect), so
 * nothing here touches NextResponse.
 */
import { auth } from '@/lib/auth';

export type AdminAuthResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'unauthorized' }
  | { ok: false; reason: 'not-configured' };

export async function requireAdmin(): Promise<AdminAuthResult> {
  const adminEmail = process.env.ADMIN_EMAIL;

  if (!adminEmail) {
    console.error('ADMIN_EMAIL is not configured -- admin routes are unreachable');
    return { ok: false, reason: 'not-configured' };
  }

  const session = await auth();
  const email = session?.user?.email;

  if (!email || email !== adminEmail) {
    return { ok: false, reason: 'unauthorized' };
  }

  return { ok: true, email };
}

/** HTTP status for a failed check: 500 for misconfiguration, 401 for a denied user. */
export function adminAuthStatus(result: Extract<AdminAuthResult, { ok: false }>): number {
  return result.reason === 'not-configured' ? 500 : 401;
}

/** Response body for a failed check. Never leaks the configured address. */
export function adminAuthError(result: Extract<AdminAuthResult, { ok: false }>): { error: string } {
  return result.reason === 'not-configured'
    ? { error: 'Admin access is not configured' }
    : { error: 'Unauthorized' };
}
