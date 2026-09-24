import { NextRequest } from 'next/server';
import { timingSafeEqual } from 'crypto';

/**
 * Constant-time check of an `Authorization: Bearer <secret>` header against
 * one expected secret. An unset secret never matches, so a route guarded by
 * a missing environment variable is unreachable rather than open.
 */
export function verifyBearerSecret(req: NextRequest, secret: string | undefined): boolean {
  if (!secret) return false;

  const header = req.headers.get('authorization');
  if (!header) return false;

  const expected = `Bearer ${secret}`;
  if (header.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * The cron containers' bearer token (CRON_SECRET).
 *
 * The unset case is logged, matching `verifyLlmPanelSecret` below. It used to
 * be silent, which made the one misconfiguration that stops EVERYTHING the one
 * that says nothing: `docker/cron-entrypoint.sh` substitutes the variable into
 * every crontab line, so an unset secret sends `Bearer ` on all of them and
 * every job 401s forever, indistinguishable from cron simply not running.
 */
export function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('CRON_SECRET is not configured -- every cron route is unreachable');
    return false;
  }
  return verifyBearerSecret(req, secret);
}

/** The local LLM panel skill's bearer token (LLM_PANEL_SECRET), separate from the cron secret. */
export function verifyLlmPanelSecret(req: NextRequest): boolean {
  const secret = process.env.LLM_PANEL_SECRET;
  if (!secret) {
    console.error('LLM_PANEL_SECRET is not configured -- llm panel routes are unreachable');
    return false;
  }
  return verifyBearerSecret(req, secret);
}
