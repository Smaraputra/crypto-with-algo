import { NextRequest, NextResponse } from 'next/server';
import { type Duration, Ratelimit } from '@upstash/ratelimit';
import { redis } from './redis';

export function createRateLimiter(
  maxRequests: number,
  window: Duration
): Ratelimit | null {
  if (!redis) return null;

  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(maxRequests, window),
    analytics: false,
  });
}

export async function rateLimit(
  req: NextRequest,
  limiter: Ratelimit | null,
  options?: { failClosed?: boolean }
): Promise<NextResponse | null> {
  if (!limiter) {
    // Redis not configured at all -- allow the request through.
    // failClosed only applies to runtime Redis errors, not missing config.
    return null;
  }

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1';

  try {
    const { success, remaining, reset } = await limiter.limit(ip);

    if (!success) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
          headers: {
            'X-RateLimit-Remaining': remaining.toString(),
            'X-RateLimit-Reset': reset.toString(),
          },
        }
      );
    }
  } catch (error) {
    console.error('Rate limiter Redis error:', error);
    if (options?.failClosed) {
      return NextResponse.json(
        { error: 'Service temporarily unavailable' },
        { status: 503 }
      );
    }
  }

  return null;
}
