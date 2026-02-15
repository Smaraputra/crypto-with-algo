import { NextRequest } from 'next/server';
import { timingSafeEqual } from 'crypto';

/**
 * Verify the CRON_SECRET bearer token from an incoming request
 * using constant-time comparison to prevent timing attacks.
 */
export function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
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
